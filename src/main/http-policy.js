'use strict';

const POLICIES = Object.freeze({
  robloxApi: Object.freeze({
    timeoutMs: 10000,
    maxBytes: 2 * 1024 * 1024,
    hosts: ['roblox.com'],
    content: /^(?:application\/(?:[a-z0-9.+-]*\+)?json)(?:;|$)/i,
    maxRetries: 2,
  }),
  robloxImage: Object.freeze({
    timeoutMs: 10000,
    maxBytes: 5 * 1024 * 1024,
    hosts: ['rbxcdn.com'],
    content: /^image\/(?:png|jpeg|webp)(?:;|$)/i,
    maxRetries: 2,
  }),
  updateFeed: Object.freeze({
    timeoutMs: 10000,
    maxBytes: 256 * 1024,
    hosts: ['github.com', 'githubusercontent.com'],
    content: /^(?:application\/(?:[a-z0-9.+-]*\+)?json|text\/plain)(?:;|$)/i,
    maxRetries: 2,
  }),
  updateArtifact: Object.freeze({
    timeoutMs: 120000,
    maxBytes: 512 * 1024 * 1024,
    hosts: ['github.com', 'githubusercontent.com'],
    content: /^(?:application\/(?:zip|octet-stream|x-zip-compressed))(?:;|$)/i,
    maxRetries: 2,
  }),
});

function hostAllowed(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return (suffixes || []).some(suffix => host === suffix || host.endsWith('.' + suffix));
}

function policyFor(name) {
  const policy = POLICIES[name];
  if (!policy) throw new Error(`Unknown HTTP policy: ${name}`);
  return policy;
}

function policyFailure(message) {
  const error = new Error(message);
  error.code = 'ENETPOLICY';
  return error;
}

function validateUrl(value, policy) {
  const url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  if (url.protocol !== 'https:') throw policyFailure('Network policy requires HTTPS.');
  if (url.username || url.password) throw policyFailure('Network URLs cannot contain credentials.');
  if (!hostAllowed(url.hostname, policy.hosts)) throw policyFailure(`Network host is not allowlisted: ${url.hostname}`);
  return url;
}

function validateContentType(response, policy) {
  if (!policy.content || response.status === 204 || response.status === 304) return;
  const type = response.headers.get('content-type') || '';
  if (!policy.content.test(type)) throw new Error('Response content type was not accepted.');
}

function requestMethod(options) {
  return String(options && options.method || 'GET').toUpperCase();
}

function canRetry(method) {
  return method === 'GET' || method === 'HEAD';
}

function retryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function sanitizedNetworkError(error, hostname) {
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? ` (${error.code})`
    : '';
  return new Error(`Network request to allowlisted host ${hostname} failed${code}.`);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('cancelled'));
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('cancelled'));
      }, { once: true });
    }
  });
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response exceeded the configured size limit.');
  if (!response.body || !response.body.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Response exceeded the configured size limit.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('size limit');
        throw new Error('Response exceeded the configured size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  return Buffer.concat(chunks, total);
}

function wrapResponse(response, policy) {
  let bodyPromise = null;
  const body = () => {
    if (!bodyPromise) bodyPromise = readBounded(response, policy.maxBytes);
    return bodyPromise;
  };
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    async arrayBuffer() {
      validateContentType(response, policy);
      const value = await body();
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    },
    async text() { return (await body()).toString('utf8'); },
    async json() {
      validateContentType(response, policy);
      const type = response.headers.get('content-type') || '';
      if (!/[/+]json\b/i.test(type)) throw new Error('Expected a JSON response.');
      return JSON.parse((await body()).toString('utf8'));
    },
  };
}

async function fetchWithPolicy(value, options, policyName) {
  const policy = policyFor(policyName || 'robloxApi');
  let url = validateUrl(value, policy);
  let requestOptions = Object.assign({}, options || {});
  const callerSignal = requestOptions.signal || null;
  const controller = new AbortController();
  const signals = [controller.signal];
  if (callerSignal) signals.push(callerSignal);
  requestOptions.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  requestOptions.redirect = 'manual';
  const timer = setTimeout(() => controller.abort(new Error('Network request timed out.')), policy.timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const attempts = canRetry(requestMethod(requestOptions)) ? policy.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response;
      try {
        for (let redirects = 0; redirects <= 5; redirects += 1) {
          response = await globalThis.fetch(url, requestOptions);
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          if (redirects === 5) throw policyFailure('Too many redirects.');
          const location = response.headers.get('location');
          if (!location) throw policyFailure('Redirect did not include a destination.');
          const next = validateUrl(new URL(location, url), policy);
          if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
            throw policyFailure('Cross-host redirects are not permitted.');
          }
          url = next;
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod(requestOptions) === 'POST')) {
            requestOptions = Object.assign({}, requestOptions, { method: 'GET' });
            delete requestOptions.body;
          }
        }
      } catch (error) {
        if (requestOptions.signal.aborted) throw error;
        if (error && error.code === 'ENETPOLICY') throw error;
        if (attempt + 1 >= attempts) throw sanitizedNetworkError(error, url.hostname);
        await wait(100 * (2 ** attempt), requestOptions.signal);
        continue;
      }
      if (!response) throw new Error('Network request produced no response.');
      if (retryableStatus(response.status) && attempt + 1 < attempts) {
        try { if (response.body) await response.body.cancel('retry'); } catch (_) {}
        await wait(100 * (2 ** attempt), requestOptions.signal);
        continue;
      }
      if (response.ok) validateContentType(response, policy);
      return wrapResponse(response, policy);
    }
    throw new Error('Network retry policy exhausted.');
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Network request timed out.');
    if (callerSignal && callerSignal.aborted) throw new Error('Network request was cancelled.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  POLICIES,
  hostAllowed,
  validateUrl,
  validateContentType,
  fetchWithPolicy,
  readBounded,
  canRetry,
  retryableStatus,
};
