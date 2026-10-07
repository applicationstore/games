import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function landing(variant, { query, ready = 'success' } = {}) {
  const html = readFileSync(new URL(`../${variant}/v003/index.html`, import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => new vm.Script(match[1]));
  let now = 0, nextID = 0, resolveReady, rejectReady;
  const timers = new Map(), downloads = [], elements = new Map();
  function schedule(fn, delay, interval = false) {
    const id = ++nextID;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  }
  function element(selector) {
    if (!elements.has(selector)) {
      const listeners = new Map();
      elements.set(selector, {
        style: {}, textContent: '', disabled: selector === '#downloadButton',
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        emit(type, data = {}) { for (const fn of listeners.get(type) || []) fn({ target: this, ...data }); },
        set src(value) { if (value !== 'about:blank') downloads.push({ at: now, url: new URL(value) }); },
      });
    }
    return elements.get(selector);
  }
  const workerReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const success = { ok: true, controller: { scriptURL: 'https://test.invalid/sw.js' } };
  if (ready === 'success') resolveReady(success);
  if (ready === 'unsupported') resolveReady({ ok: false, direct: true, reason: 'unsupported' });
  if (ready === 'failure') rejectReady(new Error('registration failed'));
  const window = {
    location: { href: `https://test.invalid/${variant}/v003/?${query ?? (variant === '1' ? 'u=https://files.invalid/app.apk' : 'offer_id=42')}&utm_medium=Example` },
    __landingParamsReady: Promise.resolve(),
    __savedDownloadParams: new URLSearchParams(`${query ?? (variant === '1' ? 'u=https://files.invalid/app.apk' : 'offer_id=42')}&utm_medium=Example`),
    __swReadyPromise: workerReady,
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => schedule(fn, ms),
    clearTimeout: id => timers.delete(id),
  };
  const paramsContext = vm.createContext({ URL, self: { location: { href: 'https://test.invalid/1/sw.js' } } });
  vm.runInContext(readFileSync(new URL('../1/params.js', import.meta.url), 'utf8'), paramsContext);
  // Execute the actual page UI script; readiness is controlled independently of its animation.
  scripts.at(-1).runInNewContext({ window, document: { querySelector: element }, URL, URLSearchParams, Landing1Params: paramsContext.Landing1Params, console: { log() {}, error() {} } });
  return {
    element, downloads, resolveReady: () => resolveReady(success),
    async tick(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.delay; else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

for (const variant of ['1', 'b1']) {
  test(`${variant}: progress, button transition, then exactly one automatic download`, async () => {
    const page = landing(variant);
    await page.tick(100);
    assert.equal(page.element('.scale-percent').textContent, '10%');
    page.element('#clickArea').emit('click', { isTrusted: true });
    await page.tick(900);
    assert.equal(page.element('.scale').style.width, '100%');
    assert.equal(page.element('.d-button-box').style.top, undefined);
    assert.equal(page.downloads.length, 0);
    await page.tick(200);
    assert.equal(page.element('.d-button-box').style.top, '0');
    assert.equal(page.element('#downloadButton').disabled, true);
    await page.tick(1000);
    page.element('.d-button-box').emit('transitionend', { propertyName: 'top' });
    await page.tick(0);
    assert.equal(page.downloads.length, 1);
    const url = page.downloads[0].url;
    assert.equal(url.pathname, `/${variant}/download.apk`);
    assert.equal(url.search, '', 'download URL must not carry saved parameters');
    assert.equal(page.element('#fileTitle').textContent, 'Example.apk');
    await page.tick(1000);
    assert.equal(page.downloads.length, 1, 'fallback must not cause a second download');
    assert.equal(page.element('#downloadButton').disabled, false);
  });

  test(`${variant}: waits for slow worker; animation completes without transitionend`, async () => {
    const page = landing(variant, { ready: 'pending' });
    await page.tick(3000);
    assert.equal(page.element('.scale-percent').textContent, '100%');
    assert.equal(page.element('.d-button-box').style.top, '0');
    page.element('#clickArea').emit('click', { isTrusted: true });
    assert.equal(page.downloads.length, 0);
    page.resolveReady();
    await page.tick(0);
    assert.equal(page.downloads.length, 1);
  });

  test(`${variant}: missing target does not download`, async () => {
    const page = landing(variant, { query: '' });
    await page.tick(3000);
    assert.equal(page.element('.scale-percent').textContent, '100%');
    assert.equal(page.element('#downloadButton').disabled, true);
    assert.equal(page.downloads.length, 0);
  });

  for (const ready of ['unsupported', 'failure']) {
    test(`${variant}: ${ready} worker respects animation and fallback policy`, async () => {
      const page = landing(variant, { ready });
      await page.tick(1200);
      assert.equal(page.downloads.length, 0);
      await page.tick(1100);
      assert.equal(page.downloads.length, variant === '1' ? 1 : 0);
      if (variant === '1') assert.equal(page.downloads[0].url.href, 'https://files.invalid/app.apk');
      assert.equal(page.element('#downloadButton').disabled, variant === 'b1');
    });
  }
}
