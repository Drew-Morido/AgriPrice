/* AgriPricePH — shared API client */
window.AgriPricePH = window.AgriPricePH || {};

AgriPricePH.API = (function () {
  const FLASK_API = 'http://127.0.0.1:5000';
  const STORAGE_KEY = 'agriprice_api_base';

  function detectBase() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return saved.replace(/\/$/, '');
    } catch { /* ignore */ }

    const host = window.location.hostname;
    const port = window.location.port;
    // Same machine + Flask serves the dashboard on 5000
    if ((host === '127.0.0.1' || host === 'localhost') && port === '5000') {
      return `${window.location.protocol}//${window.location.host}`;
    }
    // Live Server, file://, or other port — API is always on Flask :5000
    return FLASK_API;
  }

  const BASE = detectBase();

  /* Auto-attach the admin session token when one exists, so the admin dashboard authenticates
     every call it makes to the now-guarded admin endpoints. Public visitors have no admin session,
     so no header is sent and public endpoints are unaffected. */
  function adminAuthHeaders() {
    try {
      const s = JSON.parse(sessionStorage.getItem('agriprice_admin_session') || 'null');
      return s && s.token ? { Authorization: `Bearer ${s.token}` } : {};
    } catch {
      return {};
    }
  }

  async function get(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      cache: opts.noCache ? 'no-store' : 'default',
      headers: { ...adminAuthHeaders() },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Like get(), but returns JSON body even on 4xx/5xx (for /api/predictions). */
  async function getLenient(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      cache: opts.noCache ? 'no-store' : 'default',
      headers: { ...adminAuthHeaders() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ...data,
        ready: data.ready === true,
        error: data.error || `HTTP ${res.status}`,
      };
    }
    return data;
  }

  async function post(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...adminAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function put(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...adminAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function del(path) {
    const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { ...adminAuthHeaders() } });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  async function health() {
    try {
      await get('/api/health', { noCache: true });
      return true;
    } catch {
      return false;
    }
  }

  function setBase(url) {
    try {
      localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ''));
    } catch { /* ignore */ }
  }

  return {
    BASE,
    FLASK_API,
    get,
    post,
    put,
    delete: del,
    health,
    setBase,
    dataSources: () => get('/api/data-sources', { noCache: true }),
    scrapeStatus: () => get('/api/scrape-status', { noCache: true }),
    runScraper: (source) => post('/api/run-scraper', source ? { source } : {}),
    historical: () => get('/api/historical-data'),
    predictions: () => getLenient('/api/predictions', { noCache: true }),
    modelStatus: () => get('/api/model-status'),
    catalog: (includeInactive) => getLenient(
      '/api/catalog' + (includeInactive ? '?include_inactive=1' : ''), { noCache: true }),
    taxes: () => getLenient('/api/taxes', { noCache: true }),
    priceBrackets: (params = {}) => getLenient(
      '/api/prices/brackets' + (Object.keys(params).length
        ? '?' + new URLSearchParams(params).toString() : ''), { noCache: true }),
    consumerPrice: (category, date) => getLenient(
      '/api/consumer-price?' + new URLSearchParams(date ? { category, date } : { category }).toString(),
      { noCache: true }),
    tariff: (date) => getLenient(
      '/api/tariff' + (date ? '?' + new URLSearchParams({ date }).toString() : ''), { noCache: true }),
    tariffIndicative: (currentPrice, baselinePrice) => getLenient(
      '/api/tariff/indicative?' + new URLSearchParams(
        baselinePrice != null && baselinePrice !== ''
          ? { current_price: currentPrice, baseline_price: baselinePrice }
          : { current_price: currentPrice }).toString(), { noCache: true }),
    tariffAdd: (body, token) => fetch(`${BASE}/api/tariff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    tariffAudit: (token) => fetch(`${BASE}/api/tariff/audit`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store',
    }).then((r) => r.json().catch(() => ({ audit: [] }))),
    tariffSetActive: (id, active, token) => fetch(`${BASE}/api/tariff/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ active: !!active }),
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandPrices: (category, includeInactive) => {
      const params = new URLSearchParams({
        ...(category ? { category } : {}), ...(includeInactive ? { include_inactive: '1' } : {}),
      }).toString();
      return getLenient('/api/brand-prices' + (params ? '?' + params : ''), { noCache: true });
    },
    brandWeightSet: (brandId, body, token) => fetch(`${BASE}/api/brand-prices/${encodeURIComponent(brandId)}/weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandWeightAudit: (token, brandId) => fetch(
      `${BASE}/api/brand-prices/weight-audit` + (brandId ? '?' + new URLSearchParams({ brand_id: brandId }).toString() : ''),
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' },
    ).then((r) => r.json().catch(() => ({ audit: [] }))),
    brandAdd: (body, token) => fetch(`${BASE}/api/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandUpdate: (brandId, body, token) => fetch(`${BASE}/api/brands/${encodeURIComponent(brandId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandDeactivate: (brandId, token) => fetch(`${BASE}/api/brands/${encodeURIComponent(brandId)}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandReactivate: (brandId, token) => fetch(`${BASE}/api/brands/${encodeURIComponent(brandId)}/reactivate`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) })),
    brandAudit: (brandId, token) => fetch(`${BASE}/api/brands/${encodeURIComponent(brandId)}/audit`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store',
    }).then((r) => r.json().catch(() => ({ audit: [] }))),
    systemLogs: (params = {}, token) => fetch(
      `${BASE}/api/logs` + (Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''),
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' },
    ).then((r) => r.json().catch(() => ({ ready: false, logs: [] }))),
    clearSystemLogs: (token) => fetch(`${BASE}/api/logs/clear`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then((r) => ({ ok: r.ok, status: r.status })),
    trainingStatus: () => get('/api/training-status'),
    trainingHistory: () => get('/api/training-history', { noCache: true }),
    dashboardMetrics: () => get('/api/dashboard-metrics', { noCache: true }),
    runTraining: () => post('/api/run-training'),
    import2026: () => get('/api/import-2026'),
    alerts: (evaluate) => getLenient(evaluate ? '/api/alerts?evaluate=1' : '/api/alerts'),
    alertsEvaluate: () => post('/api/alerts/evaluate'),
    alertsSummary: () => getLenient('/api/alerts/summary'),
    settings: () => get('/api/settings'),
    updateSettings: (body) => put('/api/settings', body),
    resetSettings: () => post('/api/settings/reset'),
    changePassword: (current, newPw) => post('/api/settings/password', { current, new: newPw }),
    adminVerifyPassword: (username, password) =>
      post('/api/admin/verify-password', { username, password }),
    adminVerify: (username, password, access_code) =>
      post('/api/admin/verify', { username, password, access_code }),
    adminSession: (token) =>
      fetch(`${BASE}/api/admin/session`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }).then((r) => r.json()),
    adminLogout: (token) =>
      fetch(`${BASE}/api/admin/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
    // Server-side public/vendor accounts (see model/user_auth.py).
    authSignup: (name, email, password) => post('/api/auth/signup', { name, email, password }),
    authLogin: (email, password) => post('/api/auth/login', { email, password }),
    forgotPassword: (email) => post('/api/auth/forgot-password', { email }),
    verifyResetCode: (email, code) => post('/api/auth/verify-reset-code', { email, code }),
    resetPassword: (email, ticket, newPassword) =>
      post('/api/auth/reset-password', { email, ticket, new_password: newPassword }),
    authUpdateProfile: (email, name, newEmail) =>
      put('/api/auth/profile', { email, name, new_email: newEmail }),
    authChangePassword: (email, current, next) =>
      post('/api/auth/change-password', { email, current, new: next }),
    reportsHistory: () => getLenient('/api/reports/history', { noCache: true }),
    reportsGenerate: (type) => post('/api/reports/generate', { type }),
    reportsDelete: (filename) => del(`/api/reports/file/${encodeURIComponent(filename)}`),
  };
})();
