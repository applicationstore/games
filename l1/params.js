// Shared by the landing page and its service worker. Isolated to this l1 directory.
(() => {
  const root = typeof document === 'undefined'
    ? new URL('./', self.location.href)
    : new URL('./', document.currentScript.src);
  const storageKey = new URL('__saved_download_params__', root).href;
  const cacheName = 'l1-download-params-v1';
  const apkHref = 'https://inhumancrieck.shop/9d9e87dbccdbfa9715d/';

  async function read() {
    const cache = await caches.open(cacheName);
    const response = await cache.match(storageKey);
    return response ? await response.json() : [];
  }

  async function save(entries) {
    const cache = await caches.open(cacheName);
    await cache.put(storageKey, new Response(JSON.stringify(entries), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  function apkUrl(entries) {
    const target = new URL(apkHref);
    for (const [key, value] of entries) target.searchParams.append(key, value);
    return target.href;
  }

  globalThis.L1Params = { read, save, apkUrl };

  if (typeof document !== 'undefined') {
    window.__landingParamsReady = (async () => {
      const incoming = new URL(window.location.href);
      if (incoming.search) {
        await save([...incoming.searchParams]);
        incoming.search = '';
        window.location.replace(incoming.href);
        // Do not register a worker or start a download on the outgoing page.
        return await new Promise(() => {});
      }
      const entries = await read();
      window.__savedDownloadParams = new URLSearchParams(entries);
      window.__savedApkUrl = apkUrl(entries);
    })();
  }
})();
