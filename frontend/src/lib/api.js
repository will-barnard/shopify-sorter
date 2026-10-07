/**
 * Every backend call carries a fresh App Bridge session token (a short-lived
 * JWT). `shopify.idToken()` is provided by the App Bridge script in index.html
 * and handles caching/refresh for us.
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function shopFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const direct = params.get('shop');
  if (direct) return direct;

  // Shopify passes `host` as base64 of "<shop>.myshopify.com/admin".
  const host = params.get('host');
  if (host) {
    try {
      const decoded = atob(host.replace(/-/g, '+').replace(/_/g, '/'));
      const match = decoded.match(/([a-z0-9-]+\.myshopify\.com)/i);
      if (match) return match[1];
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function getSessionToken() {
  if (typeof window.shopify?.idToken !== 'function') {
    throw new ApiError(
      'App Bridge is not available. Open this app from your Shopify admin.',
      0,
      null
    );
  }
  return window.shopify.idToken();
}

/** Full-page (top-level) redirect out of the iframe to start OAuth. */
export function redirectToAuth(shop) {
  const target = shop || shopFromLocation();
  if (!target) {
    throw new ApiError('Could not determine which shop to authenticate.', 0, null);
  }
  const url = `/auth?shop=${encodeURIComponent(target)}`;
  if (window.top !== window.self && window.shopify?.environment?.embedded) {
    // App Bridge exposes the top-level redirect; fall back to window.top.
    window.open(url, '_top');
  } else {
    window.location.assign(url);
  }
}

export async function apiFetch(path, options = {}) {
  const token = await getSessionToken();

  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 204) return null;

  if (res.headers.get('X-Shopify-API-Request-Failure-Reauthorize')) {
    redirectToAuth(shopFromLocation());
    throw new ApiError('Reauthorizing…', res.status, null);
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(body?.error || `Request failed (HTTP ${res.status})`, res.status, body);
  }

  return body;
}

export const api = {
  me: () => apiFetch('/me'),
  collections: (search = '', cursor = null) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (cursor) qs.set('cursor', cursor);
    const q = qs.toString();
    return apiFetch(`/collections${q ? `?${q}` : ''}`);
  },
  tags: () => apiFetch('/tags'),
  timezones: () => apiFetch('/timezones'),
  rules: () => apiFetch('/rules'),
  createRule: (rule) => apiFetch('/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateRule: (id, rule) => apiFetch(`/rules/${id}`, { method: 'PUT', body: JSON.stringify(rule) }),
  setEnabled: (id, enabled) =>
    apiFetch(`/rules/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteRule: (id) => apiFetch(`/rules/${id}`, { method: 'DELETE' }),
  runRule: (id) => apiFetch(`/rules/${id}/run`, { method: 'POST' }),
  preview: (collectionId, strategy) =>
    apiFetch('/preview', { method: 'POST', body: JSON.stringify({ collectionId, strategy }) }),
  leadTime: () => apiFetch('/lead-time'),
  saveLeadTime: (settings) => apiFetch('/lead-time', { method: 'PUT', body: JSON.stringify(settings) }),
  previewLeadTime: (settings) =>
    apiFetch('/lead-time/preview', { method: 'POST', body: JSON.stringify(settings) }),
  runLeadTime: () => apiFetch('/lead-time/run', { method: 'POST' }),
  runs: (ruleId = null) => apiFetch(`/runs${ruleId ? `?ruleId=${ruleId}` : ''}`),
};

export { shopFromLocation };
