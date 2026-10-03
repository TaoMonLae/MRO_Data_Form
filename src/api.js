export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const isFormData = options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) {
    headers.set('X-MRO-Request', '1');
  }

  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers
  });

  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (response.status === 401 && ['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(payload?.code) && path !== '/api/auth/session') {
      window.dispatchEvent(new Event('mro:session-expired'));
    }
    if (response.status === 403 && payload?.code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event('mro:password-change-required'));
    }
    const message = payload?.error || payload?.errors?.[0]?.msg || (typeof payload === 'string' && !payload.trim().startsWith('<') ? payload : '') || `Request failed (${response.status}). Please try again.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}
