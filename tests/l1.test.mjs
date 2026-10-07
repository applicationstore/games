import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sharedCode = readFileSync(new URL('../l1/params.js', import.meta.url), 'utf8');
const workerCode = readFileSync(new URL('../l1/sw.js', import.meta.url), 'utf8');
const origin = 'https://test.invalid/project/l1/';
const upstream = 'https://inhumancrieck.shop/9d9e87dbccdbfa9715d/';
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
async function workerDownload(caches) {
  const handlers = {}, requests = [];
  const context = vm.createContext({ caches, URL, Response, Headers, ReadableStream, console,
    setTimeout(fn) { fn(); },
    self: { location: { href: origin + 'sw.js?v=version' }, addEventListener(type, handler) { handlers[type] = handler; } },
    fetch: async url => { requests.push(url); return new Response(new Uint8Array([80, 75, 3, 4])); },
    importScripts() { vm.runInContext(sharedCode, context); },
  });
  vm.runInContext(workerCode, context);
  let response;
  handlers.fetch({ request: { url: origin + 'download.apk' }, respondWith(promise) { response = promise; } });
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal((await result.arrayBuffer()).byteLength, 4);
  return requests[0];
}

for (const path of ['', 'v001/', 'v002/', 'v003/']) {
  test(`l1/${path}: persist before redirect, reload and worker restart retain every parameter`, async () => {
    const caches = storage();
    const query = '?clickid=abc%2B123&utm_medium=hello+world&tag=one&tag=two&empty=&unicode=%D1%82%D0%B5%D1%81%D1%82#section';
    const incoming = page(caches, path, query);
    await flush();
    assert.equal(incoming.redirect, origin + path + '#section');
    let ready = false;
    incoming.window.__landingParamsReady.then(() => { ready = true; });
    await flush();
    assert.equal(ready, false, 'outgoing page must not download');
    const clean = page(caches, path);
    await clean.window.__landingParamsReady;
    assert.equal(clean.redirect, undefined);
    const expected = new URL(upstream);
    expected.search = new URL(origin + query).search;
    assert.equal(clean.window.__savedApkUrl, expected.href);
    assert.equal(clean.window.__savedDownloadParams.get('clickid'), 'abc+123');
    assert.equal(await workerDownload(caches), expected.href);
    assert.equal(await workerDownload(caches), expected.href, 'new worker reads persistent data');
  });
}

test('new incoming query replaces old parameters; clean visit retains them', async () => {
  const caches = storage();
  page(caches, '', '?old=one&clickid=old');
  await flush();
  page(caches, '', '?clickid=new');
  await flush();
  assert.equal(await workerDownload(caches), upstream + '?clickid=new');
});

test('fresh clean visit uses original APK URL', async () => {
  const caches = storage();
  const clean = page(caches, '');
  await clean.window.__landingParamsReady;
  assert.equal(clean.window.__savedApkUrl, upstream);
  assert.equal(await workerDownload(caches), upstream);
});

test('storage failure prevents redirect and does not silently lose parameters', async () => {
  const incoming = page({ async open() { throw new Error('storage denied'); } }, '', '?clickid=keep');
  await assert.rejects(incoming.window.__landingParamsReady, /storage denied/);
  assert.equal(incoming.redirect, undefined);
});

for (const path of ['', 'v001/', 'v002/', 'v003/']) {
  for (const direct of [false, true]) {
    test(`l1/${path}: ${direct ? 'fallback uses saved query' : 'worker download URL has no query'}`, async () => {
      const caches = storage();
      page(caches, path, '?clickid=saved&tag=one&tag=two');
      await flush();
      const clean = page(caches, path);
      await clean.window.__landingParamsReady;
      const timers = [], downloads = [];
      const element = { style: {}, addEventListener() {}, removeEventListener() {}, click() {},
        set src(url) { if (url !== 'about:blank') downloads.push(url); } };
      clean.context.console = { log() {}, error() {} };
      clean.context.document.querySelector = () => element;
      Object.assign(clean.window, { __swReadyPromise: Promise.resolve({ ok: !direct, direct }),
        setTimeout(fn) { timers.push(fn); }, setInterval() {}, clearInterval() {}, clearTimeout() {},
      });
      const html = readFileSync(new URL(`../l1/${path}index.html`, import.meta.url), 'utf8');
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      for (const script of scripts) new vm.Script(script[1]);
      vm.runInContext(scripts.at(-1)[1], clean.context);
      await flush();
      vm.runInContext('startDownload()', clean.context);
      for (const fn of timers) fn();
      assert.deepEqual(downloads, [direct ? upstream + '?clickid=saved&tag=one&tag=two' : origin + 'download.apk']);
    });
  }
}
