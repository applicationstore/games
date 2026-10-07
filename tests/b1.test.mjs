import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sharedCode = readFileSync(new URL('../b1/params.js', import.meta.url), 'utf8');
const workerCode = readFileSync(new URL('../b1/sw.js', import.meta.url), 'utf8');
const origin = 'https://test.invalid/project/b1/';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function storage() {
  const records = new Map();
  return { async open(name) { return {
    async put(key, response) { records.set(name + key, await response.text()); },
    async match(key) { const data = records.get(name + key); return data === undefined ? undefined : new Response(data); },
  }; } };
}
function page(caches, path, query = '') {
  let redirect;
  const window = { location: { href: origin + path + query, replace(url) { redirect = url; } } };
  const context = vm.createContext({ window, caches, URL, URLSearchParams, Response,
    document: { currentScript: { src: origin + 'params.js?v=l1-2' } },
  });
  vm.runInContext(sharedCode, context);
  return { window, context, get redirect() { return redirect; } };
}
function worker(caches, template = 'https://files.invalid/app.apk?click={clickid}&medium={t2}&source={t3}&custom={custom}') {
  const handlers = {}, requests = [];
  const context = vm.createContext({ caches, URL, URLSearchParams, Response, Headers, ReadableStream, console,
    setTimeout(fn) { fn(); },
    self: { location: { href: origin + 'sw.js' }, addEventListener(type, fn) { handlers[type] = fn; } },
    fetch: async url => {
      requests.push(new URL(url));
      return url.includes('offer-link.php')
        ? new Response(JSON.stringify({ url: template }))
        : new Response(new Uint8Array([80, 75, 3, 4]));
    },
    importScripts() { vm.runInContext(sharedCode, context); },
  });
  vm.runInContext(workerCode, context);
  return { requests, async download() {
    let response;
    handlers.fetch({ request: { url: origin + 'download.apk' }, respondWith(p) { response = p; } });
    return await response;
  } };
}

for (const path of ['', 'v001/', 'v002/', 'v003/']) {
  test(`b1/${path}: save before clean redirect, restore and download without query`, async () => {
    const caches = storage();
    const query = '?offer_id=936&clickid=a%2Bb&utm_medium=Example&utm_source=source&tag=one&tag=two&custom=x%26y#section';
    const incoming = page(caches, path, query);
    await flush();
    assert.equal(incoming.redirect, origin + path + '#section');
    let ready = false;
    incoming.window.__landingParamsReady.then(() => { ready = true; });
    await flush();
    assert.equal(ready, false);
    const clean = page(caches, path);
    await clean.window.__landingParamsReady;
    assert.equal(clean.redirect, undefined);
    assert.deepEqual([...clean.window.__savedDownloadParams.getAll('tag')], ['one', 'two']);
    const timers = [], downloads = [];
    const elements = new Map();
    clean.context.document.querySelector = selector => {
      if (!elements.has(selector)) elements.set(selector, {
        style: {}, addEventListener() {}, removeEventListener() {}, click() {},
        set src(url) { if (url !== 'about:blank') downloads.push(url); },
      });
      return elements.get(selector);
    };
    clean.context.console = { log() {}, error() {} };
    Object.assign(clean.window, { __swReadyPromise: Promise.resolve({ ok: true }),
      setTimeout(fn) { timers.push(fn); }, setInterval() {}, clearInterval() {}, clearTimeout() {},
    });
    const html = readFileSync(new URL(`../b1/${path}index.html`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    for (const script of scripts) new vm.Script(script[1]);
    vm.runInContext(scripts.at(-1)[1], clean.context);
    await flush();
    vm.runInContext('startDownload()', clean.context);
    for (const fn of timers) fn();
    assert.deepEqual(downloads, [origin + 'download.apk']);
    assert.equal(elements.get('#fileTitle').textContent, 'Example.apk');
    // A fresh worker must read persisted parameters and query the API even for 936.
    const sw = worker(caches);
    const result = await sw.download();
    assert.equal(result.status, 200);
    assert.equal((await result.arrayBuffer()).byteLength, 4);
    assert.match(result.headers.get('Content-Disposition'), /Example\.apk/);
    assert.equal(sw.requests[0].pathname, '/landers/gitand/offer-link.php');
    assert.equal(sw.requests[0].searchParams.get('offer_id'), '936');
    assert.equal(sw.requests[0].searchParams.get('click_id'), 'a+b');
    const params = sw.requests[1].searchParams;
    assert.equal(params.get('click'), 'a+b');
    assert.equal(params.get('utm_id'), 'a+b');
    assert.equal(params.get('medium'), 'Example');
    assert.equal(params.get('source'), 'source');
    assert.equal(params.get('custom'), 'x&y');
  });
}

for (const alias of ['click_id', 'utm_id', 'clickid', 'clickId']) {
  test(`preserves ${alias} alias and explicit t2/t3 precedence`, async () => {
    const caches = storage();
    page(caches, '', `?offer_id=42&${alias}=identifier&t2=two&t3=three&utm_medium=ignored&utm_source=ignored`);
    await flush();
    const sw = worker(caches);
    await (await sw.download()).arrayBuffer();
    assert.equal(sw.requests[0].searchParams.get('click_id'), 'identifier');
    assert.equal(sw.requests[1].searchParams.get('medium'), 'two');
    assert.equal(sw.requests[1].searchParams.get('source'), 'three');
  });
}

test('new visit replaces parameters and invalidates previous APK response', async () => {
  const caches = storage();
  page(caches, '', '?offer_id=42&clickid=old');
  await flush();
  const sw = worker(caches);
  await (await sw.download()).arrayBuffer();
  page(caches, '', '?offer_id=936&clickid=new');
  await flush();
  await (await sw.download()).arrayBuffer();
  assert.equal(sw.requests.length, 4);
  assert.equal(sw.requests[2].searchParams.get('offer_id'), '936');
  assert.equal(sw.requests[3].searchParams.get('utm_id'), 'new');
});

test('missing saved offer makes no API or APK request', async () => {
  const sw = worker(storage());
  assert.equal((await sw.download()).status, 400);
  assert.equal(sw.requests.length, 0);
});

test('storage failure does not redirect or discard incoming query', async () => {
  const incoming = page({ async open() { throw new Error('storage denied'); } }, '', '?offer_id=936');
  await assert.rejects(incoming.window.__landingParamsReady, /storage denied/);
  assert.equal(incoming.redirect, undefined);
});
