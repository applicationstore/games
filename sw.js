self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function sanitizeFileName(value) {
  const fallback = 'download.apk';
  const normalized = String(value || fallback).replace(/[^\w.-]+/g, '_');
  return normalized.toLowerCase().endsWith('.apk') ? normalized : `${normalized}.apk`;
}

function buildApkResponse(sourceResponse, fileName) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.android.package-archive');
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);

  const length = sourceResponse.headers.get('content-length');
  if (length) {
    headers.set('Content-Length', length);
  }

  return new Response(sourceResponse.body, {
    status: 200,
    statusText: 'OK',
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.endsWith('/download.apk')) {
    event.respondWith((async () => {
      const source = requestUrl.searchParams.get('src');
      const fileName = sanitizeFileName(requestUrl.searchParams.get('name'));

      if (!source) {
        return new Response('Missing src parameter', { status: 400 });
      }

      let sourceUrl;
      try {
        sourceUrl = new URL(source);
      } catch (error) {
        return new Response('Invalid src parameter', { status: 400 });
      }

      if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
        return new Response('Unsupported source protocol', { status: 400 });
      }

      try {
        const sourceResponse = await fetch(sourceUrl.href, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow',
        });

        if (!sourceResponse.ok) {
          return new Response(`APK source returned HTTP ${sourceResponse.status}`, {
            status: 502,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
            },
          });
        }

        return buildApkResponse(sourceResponse, fileName);
      } catch (error) {
        return Response.redirect(sourceUrl.href, 302);
      }
    })());
  }
});
