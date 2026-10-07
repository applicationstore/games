import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sharedCode = readFileSync(new URL('../1/params.js', import.meta.url), 'utf8');
const workerCode = readFileSync(new URL('../1/sw.js', import.meta.url), 'utf8');
const origin = 'https://test.invalid/project/1/';
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
function worker(caches) {
  const handlers = {}, requests = [];
  const context = vm.createContext({ caches, URL, URLSearchParams, Response, Headers, ReadableStream, console,
    setTimeout(fn) { fn(); },
    self: { location: { href: origin + 'sw.js' }, addEventListener(type, fn) { handlers[type] = fn; } },
    fetch: async url => { requests.push(url); return new Response(new Uint8Array([80, 75, 3, 4])); },
    importScripts() { vm.runInContext(sharedCode, context); },
  });
  vm.runInContext(workerCode, context);
  return { requests, async download() {
    let response;
    handlers.fetch({ request: { url: origin + 'download.apk' }, respondWith(p) { response = p; } });
    return await response;
  } };
}
const cases = [
  { name: 'u', query: '?u=https%3A%2F%2Ffiles.invalid%2Fapp.apk%3Fx%3Da%252Bb&utm_medium=Example&clickid=test', expected: 'https://files.invalid/app.apk?x=a%2Bb' },
  { name: 'domain+p', query: '?domain=files.invalid&p=app&utm_medium=Example&clickid=test&custom=a%2Bb&empty=&name=ignored', expected: 'https://files.invalid/app/?utm_medium=Example&clickid=test&custom=a%2Bb&empty=' },
];
for (const path of ['', 'v001/', 'v002/', 'v003/']) {
  for (const { name, query, expected } of cases) {
    test(`1/${path}: ${name} survives clean redirect and worker restart`, async () => {
      const caches = storage();
      const incoming = page(caches, path, query);
      await flush();
      assert.equal(incoming.redirect, origin + path);
      let ready = false;
      incoming.window.__landingParamsReady.then(() => { ready = true; });
      await flush();
      assert.equal(ready, false);
      for (const direct of [false, true]) {
        const clean = page(caches, path);
        await clean.window.__landingParamsReady;
        const timers = [], downloads = [], elements = new Map();
        clean.context.document.querySelector = selector => {
          if (!elements.has(selector)) elements.set(selector, {
            style: {}, addEventListener() {}, removeEventListener() {}, click() {},
            set src(url) { if (url !== 'about:blank') downloads.push(url); },
          });
          return elements.get(selector);
        };
        clean.context.console = { log() {}, error() {} };
        Object.assign(clean.window, { __swReadyPromise: Promise.resolve({ ok: !direct, direct }),
          setTimeout(fn) { timers.push(fn); }, setInterval() {}, clearInterval() {}, clearTimeout() {},
        });
        const html = readFileSync(new URL(`../1/${path}index.html`, import.meta.url), 'utf8');
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        for (const script of scripts) new vm.Script(script[1]);
        vm.runInContext(scripts.at(-1)[1], clean.context);
        await flush();
        vm.runInContext('startDownload()', clean.context);
        for (const fn of timers) fn();
        assert.deepEqual(downloads, [direct ? expected : origin + 'download.apk']);
        assert.equal(elements.get('#fileTitle').textContent, 'Example.apk');
      }
      const sw = worker(caches);
      const response = await sw.download();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Disposition'), /Example\.apk/);
      assert.equal((await response.arrayBuffer()).byteLength, 4);
      assert.deepEqual(sw.requests, [expected]);
    });
  }
}
for (const query of ['', '?u=javascript%3Aalert(1)', '?domain=files.invalid']) {
  test(`missing or invalid source is rejected: ${query}`, async () => {
    const caches = storage();
    page(caches, '', query);
    await flush();
    const sw = worker(caches);
    assert.equal((await sw.download()).status, 400);
    assert.equal(sw.requests.length, 0);
  });
}
test('a new incoming source replaces the previous saved source and cached APK', async () => {
  const caches = storage();
  page(caches, '', '?u=https://files.invalid/first.apk');
  await flush();
  const sw = worker(caches);
  await (await sw.download()).arrayBuffer();
  page(caches, '', '?u=https://files.invalid/second.apk');
  await flush();
  await (await sw.download()).arrayBuffer();
  assert.deepEqual(sw.requests, ['https://files.invalid/first.apk', 'https://files.invalid/second.apk']);
});
