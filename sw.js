self.addEventListener('install', () => {
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

function buildErrorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildStreamingApkResponse(sourceResponse, fileName) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.android.package-archive');
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  headers.set('Cache-Control', 'no-store');

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

  if (!requestUrl.pathname.endsWith('/download.apk')) {
    return;
  }

  event.respondWith((async () => {
    const source = requestUrl.searchParams.get('src');
    const fileName = sanitizeFileName(requestUrl.searchParams.get('name'));

    if (!source) {
      return buildErrorResponse('Missing src parameter', 400);
    }

    let sourceUrl;
    try {
      sourceUrl = new URL(source);
    } catch (error) {
      return buildErrorResponse('Invalid src parameter', 400);
    }

    if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
      return buildErrorResponse('Unsupported source protocol', 400);
    }

    try {
      const sourceResponse = await fetch(sourceUrl.href, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
      });

      if (!sourceResponse.ok) {
        return buildErrorResponse(`APK source returned HTTP ${sourceResponse.status}`, 502);
      }

      return buildStreamingApkResponse(sourceResponse, fileName);
    } catch (error) {
      return buildErrorResponse(`APK download failed: ${error.message}`, 502);
    }
  })());
});
