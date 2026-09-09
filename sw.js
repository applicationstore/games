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

let apkPromise = null;
let apkError = null;
let apkSourceHref = null;
let apkState = null;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function isUsableContentLength(value) {
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0;
}

function resetApkState() {
  apkPromise = null;
  apkError = null;
  apkSourceHref = null;
  apkState = null;
}

function notifySubscribers(state, method, value) {
  state.subscribers.forEach((subscriber) => {
    try {
      subscriber[method](value);
    } catch (error) {
      console.error('[download] subscriber notification failed', error);
    }
  });
}

async function pumpApkBody(state, response) {
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        state.done = true;
        notifySubscribers(state, 'close');
        state.subscribers.clear();
        return;
      }

      state.chunks.push(value);
      notifySubscribers(state, 'enqueue', value);
    }
  } catch (error) {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  }
}

function createApkState(sourceUrl) {
  const state = {
    href: sourceUrl.href,
    chunks: [],
    subscribers: new Set(),
    done: false,
    error: null,
    contentLength: null,
    contentType: 'application/vnd.android.package-archive',
  };

  apkState = state;
  apkSourceHref = sourceUrl.href;

  apkPromise = (async () => {
    const response = await fetch(sourceUrl.href, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (isUsableContentLength(contentLength)) {
      state.contentLength = contentLength;
    }

    state.contentType = response.headers.get('content-type') || state.contentType;

    pumpApkBody(state, response).catch((error) => {
      console.error('[download] upstream body read failed', error);
    });

    return state;
  })().catch((error) => {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  });

  return state;
}

async function getApkState(sourceUrl) {
  if (apkSourceHref && apkSourceHref !== sourceUrl.href) {
    resetApkState();
  }

  if (apkError) {
    throw apkError;
  }

  if (!apkState) {
    createApkState(sourceUrl);
  }

  await apkPromise;
  return apkState;
}

async function buildDeferredApkResponse(sourceUrl, fileName) {
  const state = await getApkState(sourceUrl);
  const headers = new Headers();
  headers.set('Content-Type', state.contentType);
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  headers.set('Cache-Control', 'no-store');

  if (state.contentLength) {
    headers.set('Content-Length', state.contentLength);
  }

  let subscriber = null;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        await delay(100);

        for (const chunk of state.chunks) {
          controller.enqueue(chunk);
        }

        if (state.error) {
          controller.error(state.error);
          return;
        }

        if (state.done) {
          controller.close();
          return;
        }

        subscriber = {
          enqueue: (chunk) => controller.enqueue(chunk),
          close: () => controller.close(),
          error: (error) => controller.error(error),
        };

        state.subscribers.add(subscriber);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // Keep the upstream fetch alive so another click on the same page can reuse it.
      if (subscriber) {
        state.subscribers.delete(subscriber);
      }
    },
  });

  return new Response(stream, {
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
      return await buildDeferredApkResponse(sourceUrl, fileName);
    } catch (error) {
      return buildErrorResponse(`APK download failed: ${error.message}`, 502);
    }
  })());
});
