// Shared by the landing page and its service worker. Isolated to this 1 directory.
(() => {
  const root = typeof document === 'undefined'
    ? new URL('./', self.location.href)
    : new URL('./', document.currentScript.src);
  const storageKey = new URL('__saved_download_params__', root).href;
  const cacheName = 'landing1-download-params-v1';

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

  function sanitizeFileName(value) {
    const fallbackBase = 'download9918';
    const candidate = String(value || '')
      .replace(/\.apk$/i, '')
      .slice(0, 80);
    const isValid = candidate !== ''
      && !/^[ _-]+$/.test(candidate)
      && !/^ /.test(candidate)
      && /^[a-zA-Z0-9_*(). -]+$/.test(candidate);
    const base = isValid ? candidate : fallbackBase;
    return `${base}.apk`;
  }

  function apkUrl(params) {
    const value = params.get('u');
    if (value) {
      try {
        const target = new URL(value);
        if (!['http:', 'https:'].includes(target.protocol)) {
          return null;
        }

        return target.href;
      } catch (error) {
        return null;
      }
    }

    const domain = params.get('domain');
    const path = params.get('p');
    if (!domain || !path) {
      return null;
    }

    const cleanDomain = domain
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
    const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const target = new URL(`https://${cleanDomain}/${cleanPath}/`);

    params.forEach((paramValue, key) => {
      if (!['u', 'domain', 'p', 'name', 'filename'].includes(key)) {
        target.searchParams.set(key, paramValue);
      }
    });

    return target.href;
  }


  globalThis.Landing1Params = { read, save, apkUrl, sanitizeFileName };

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
    })();
  }
})();
