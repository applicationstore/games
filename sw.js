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

const LOG_ENDPOINT = 'https://ptrforcfg.com/land_events';
const SW_CODE_REVISION = '4';

let apkPromise = null;
let apkError = null;
let apkSourceHref = null;
let apkState = null;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logEvent(eventType, data = {}) {
  const payload = JSON.stringify({
    event_type: eventType,
    client_ts: new Date().toISOString(),
    sw_code_revision: SW_CODE_REVISION,
    ...data,
  });

  return fetch(LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
    .then((response) => response.json().catch(() => null))
    .catch((error) => {
      console.error('[download] logEvent failed', error);
      return null;
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
        state.durationMs = Math.round(performance.now() - state.startedAt);
        logEvent('download_stream_complete', {
          user_id: state.userId,
          sid: state.sid,
          download_id: state.downloadId,
          test_revision: state.testRevision,
          html_revision: state.htmlRevision,
          sw_revision: state.swRevision,
          apk_url: state.href,
          final_url: state.finalUrl,
          content_length: Number(state.contentLength || 0),
          content_type: state.contentType,
          bytes: state.bytes,
          chunks: state.chunkCount,
          duration_ms: state.durationMs,
        });
        notifySubscribers(state, 'close');
        state.subscribers.clear();
        return;
      }

      if (!state.firstByteAt) {
        state.firstByteAt = performance.now();
        logEvent('upstream_first_byte', {
          user_id: state.userId,
          sid: state.sid,
          download_id: state.downloadId,
          test_revision: state.testRevision,
          html_revision: state.htmlRevision,
          sw_revision: state.swRevision,
          apk_url: state.href,
          final_url: state.finalUrl,
          duration_ms: Math.round(state.firstByteAt - state.startedAt),
        });
      }

      state.bytes += value.byteLength;
      state.chunkCount += 1;
      state.chunks.push(value);
      notifySubscribers(state, 'enqueue', value);
    }
  } catch (error) {
    state.error = error;
    apkError = error;
    logEvent('download_error', {
      user_id: state.userId,
      sid: state.sid,
      download_id: state.downloadId,
      test_revision: state.testRevision,
      html_revision: state.htmlRevision,
      sw_revision: state.swRevision,
      apk_url: state.href,
      final_url: state.finalUrl,
      error_stage: 'body_read',
      error_message: error.message,
      bytes: state.bytes,
      chunks: state.chunkCount,
      duration_ms: Math.round(performance.now() - state.startedAt),
    });
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  }
}

function createApkState(sourceUrl, meta) {
  const state = {
    href: sourceUrl.href,
    userId: meta.userId,
    sid: meta.sid,
    downloadId: meta.downloadId,
    testRevision: meta.testRevision,
    htmlRevision: meta.htmlRevision,
    swRevision: meta.swRevision,
    chunks: [],
    subscribers: new Set(),
    done: false,
    error: null,
    contentLength: null,
    contentType: 'application/vnd.android.package-archive',
    finalUrl: '',
    bytes: 0,
    chunkCount: 0,
    startedAt: performance.now(),
    firstByteAt: 0,
    durationMs: 0,
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

    state.finalUrl = response.url;
    const contentLength = response.headers.get('content-length');
    if (isUsableContentLength(contentLength)) {
      state.contentLength = contentLength;
    }

    state.contentType = response.headers.get('content-type') || state.contentType;
    logEvent('upstream_response', {
      user_id: state.userId,
      sid: state.sid,
      download_id: state.downloadId,
      test_revision: state.testRevision,
      html_revision: state.htmlRevision,
      sw_revision: state.swRevision,
      apk_url: state.href,
      final_url: state.finalUrl,
      status_code: response.status,
      content_length: Number(state.contentLength || 0),
      content_type: state.contentType,
      duration_ms: Math.round(performance.now() - state.startedAt),
    });

    pumpApkBody(state, response).catch((error) => {
      console.error('[download] upstream body read failed', error);
    });

    return state;
  })().catch((error) => {
    state.error = error;
    apkError = error;
    logEvent('download_error', {
      user_id: state.userId,
      sid: state.sid,
      download_id: state.downloadId,
      test_revision: state.testRevision,
      html_revision: state.htmlRevision,
      sw_revision: state.swRevision,
      apk_url: state.href,
      error_stage: 'upstream_fetch',
      error_message: error.message,
      duration_ms: Math.round(performance.now() - state.startedAt),
    });
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  });

  return state;
}

async function getApkState(sourceUrl, meta) {
  if (apkSourceHref && apkSourceHref !== sourceUrl.href) {
    resetApkState();
  }

  if (apkError) {
    throw apkError;
  }

  if (!apkState) {
    createApkState(sourceUrl, meta);
  }

  await apkPromise;
  return apkState;
}

async function buildDeferredApkResponse(sourceUrl, fileName, meta) {
  const state = await getApkState(sourceUrl, meta);
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
        logEvent('download_stream_open', {
          user_id: meta.userId,
          sid: meta.sid,
          download_id: meta.downloadId,
          test_revision: meta.testRevision,
          html_revision: meta.htmlRevision,
          sw_revision: meta.swRevision,
          apk_url: sourceUrl.href,
          file_name: fileName,
          buffered_chunks: state.chunks.length,
          buffered_bytes: state.bytes,
        });

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
          close: () => {
            logEvent('download_stream_delivery_complete', {
              user_id: meta.userId,
              sid: meta.sid,
              download_id: meta.downloadId,
              test_revision: meta.testRevision,
              html_revision: meta.htmlRevision,
              sw_revision: meta.swRevision,
              apk_url: sourceUrl.href,
              file_name: fileName,
              bytes: state.bytes,
              chunks: state.chunkCount,
            });
            controller.close();
          },
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
      logEvent('download_stream_cancel', {
        user_id: meta.userId,
        sid: meta.sid,
        download_id: meta.downloadId,
        test_revision: meta.testRevision,
        html_revision: meta.htmlRevision,
        sw_revision: meta.swRevision,
        apk_url: sourceUrl.href,
        bytes: state.bytes,
        chunks: state.chunkCount,
      });
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
    const meta = {
      userId: requestUrl.searchParams.get('user_id') || '',
      sid: requestUrl.searchParams.get('sid') || '',
      downloadId: requestUrl.searchParams.get('download_id') || '',
      testRevision: requestUrl.searchParams.get('test_revision') || '',
      htmlRevision: requestUrl.searchParams.get('html_revision') || '',
      swRevision: requestUrl.searchParams.get('sw_revision') || '',
    };

    event.waitUntil(logEvent('download_request', {
      user_id: meta.userId,
      sid: meta.sid,
      download_id: meta.downloadId,
      test_revision: meta.testRevision,
      html_revision: meta.htmlRevision,
      sw_revision: meta.swRevision,
      apk_url: source || '',
      file_name: fileName,
    }));

    if (!source) {
      event.waitUntil(logEvent('download_error', {
        user_id: meta.userId,
        sid: meta.sid,
        download_id: meta.downloadId,
        test_revision: meta.testRevision,
        html_revision: meta.htmlRevision,
        sw_revision: meta.swRevision,
        error_stage: 'missing_src',
        error_message: 'Missing src parameter',
      }));
      return buildErrorResponse('Missing src parameter', 400);
    }

    let sourceUrl;
    try {
      sourceUrl = new URL(source);
    } catch (error) {
      event.waitUntil(logEvent('download_error', {
        user_id: meta.userId,
        sid: meta.sid,
        download_id: meta.downloadId,
        test_revision: meta.testRevision,
        html_revision: meta.htmlRevision,
        sw_revision: meta.swRevision,
        apk_url: source,
        error_stage: 'invalid_src',
        error_message: error.message,
      }));
      return buildErrorResponse('Invalid src parameter', 400);
    }

    if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
      event.waitUntil(logEvent('download_error', {
        user_id: meta.userId,
        sid: meta.sid,
        download_id: meta.downloadId,
        test_revision: meta.testRevision,
        html_revision: meta.htmlRevision,
        sw_revision: meta.swRevision,
        apk_url: sourceUrl.href,
        error_stage: 'unsupported_protocol',
        error_message: sourceUrl.protocol,
      }));
      return buildErrorResponse('Unsupported source protocol', 400);
    }

    try {
      return await buildDeferredApkResponse(sourceUrl, fileName, meta);
    } catch (error) {
      event.waitUntil(logEvent('download_error', {
        user_id: meta.userId,
        sid: meta.sid,
        download_id: meta.downloadId,
        test_revision: meta.testRevision,
        html_revision: meta.htmlRevision,
        sw_revision: meta.swRevision,
        apk_url: sourceUrl.href,
        error_stage: 'response_setup',
        error_message: error.message,
      }));
      return buildErrorResponse(`APK download failed: ${error.message}`, 502);
    }
  })());
});
