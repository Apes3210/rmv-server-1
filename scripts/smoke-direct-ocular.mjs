/**
 * Direct ocular workflow smoke test (feature-gated paths).
 *
 * Usage:
 *   node scripts/smoke-direct-ocular.mjs
 *
 * Environment variables:
 *   SMOKE_BASE_URL                        default: http://localhost:5000/api/v1
 *   SMOKE_CUSTOMER_EMAIL                  required for customer flow checks
 *   SMOKE_CUSTOMER_PASSWORD               required for customer flow checks
 *   SMOKE_SALES_EMAIL                     required for sales flow checks
 *   SMOKE_SALES_PASSWORD                  required for sales flow checks
 *   SMOKE_TARGET_CUSTOMER_ID              customer id to target for sales-staff direct create
 *   SMOKE_TARGET_APPOINTMENT_ID           ocular appointment id to try finalize (optional)
 */

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api/v1';
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';

class Session {
  constructor() {
    this.cookies = new Map();
    this.accessToken = null;
    this.refreshToken = null;
  }

  cookieHeader() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  applySetCookies(res) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const rawCookie of setCookies) {
      const [cookiePart] = rawCookie.split(';');
      const [name, ...valueParts] = cookiePart.split('=');
      if (!name) continue;
      this.cookies.set(name.trim(), valueParts.join('=').trim());
    }
  }

  async request(method, path, { body } = {}) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const headers = {};

    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;

    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (this.refreshToken) headers['X-Refresh-Token'] = this.refreshToken;

    const upperMethod = method.toUpperCase();
    if (!['GET', 'HEAD'].includes(upperMethod)) {
      headers['Content-Type'] = 'application/json';
      const csrf = this.cookies.get('csrfToken');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(url, {
      method: upperMethod,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    this.applySetCookies(res);

    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore non-json
    }

    return { status: res.status, data };
  }
}

function check(name, condition, details = '') {
  if (condition) {
    console.log(`${PASS} ${name}`);
    return true;
  }
  console.log(`${FAIL} ${name}${details ? `: ${details}` : ''}`);
  return false;
}

async function login(email, password) {
  const s = new Session();
  const csrf = await s.request('GET', '/csrf-token');
  if (csrf.status !== 200) throw new Error(`csrf-token failed: ${csrf.status}`);

  const loginRes = await s.request('POST', '/auth/login', { body: { email, password } });
  s.accessToken = loginRes.data?.data?.accessToken || null;
  s.refreshToken = loginRes.data?.data?.refreshToken || null;

  if (loginRes.status !== 200 || !s.accessToken || !s.refreshToken) {
    throw new Error(`login failed: ${loginRes.status}`);
  }

  return s;
}

function nextWeekdayDate(daysAhead = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`${INFO} Base URL: ${BASE_URL}`);

  const customerEmail = process.env.SMOKE_CUSTOMER_EMAIL;
  const customerPassword = process.env.SMOKE_CUSTOMER_PASSWORD;
  const salesEmail = process.env.SMOKE_SALES_EMAIL;
  const salesPassword = process.env.SMOKE_SALES_PASSWORD;
  const targetCustomerId = process.env.SMOKE_TARGET_CUSTOMER_ID;
  const targetAppointmentId = process.env.SMOKE_TARGET_APPOINTMENT_ID;

  let failures = 0;

  if (customerEmail && customerPassword) {
    console.log(`${INFO} Running customer direct-ocular check`);
    const customer = await login(customerEmail, customerPassword);
    const createRes = await customer.request('POST', '/appointments', {
      body: {
        type: 'ocular',
        date: nextWeekdayDate(7),
        slotCode: '09:00',
        purpose: 'smoke direct ocular',
      },
    });

    const msg = createRes.data?.error?.message || createRes.data?.message || '';
    const code = createRes.data?.error?.code || createRes.data?.code || '';
    const reason = createRes.data?.error?.details?.reason;

    const ok =
      createRes.status === 201 ||
      (createRes.status === 400 && code === 'VALIDATION_ERROR' && reason === 'consultation_required') ||
      (createRes.status === 400 && code === 'VALIDATION_ERROR' && reason === 'feature_disabled_or_not_in_pilot');

    if (!check('Customer direct ocular response shape', ok, `status=${createRes.status} code=${code} msg=${msg}`)) {
      failures += 1;
    }
  } else {
    console.log(`${WARN} Skipping customer flow check (SMOKE_CUSTOMER_EMAIL/PASSWORD not provided)`);
  }

  if (salesEmail && salesPassword && targetCustomerId) {
    console.log(`${INFO} Running sales-staff direct-ocular create check`);
    const sales = await login(salesEmail, salesPassword);

    const createRes = await sales.request('POST', '/appointments/agent-create-ocular', {
      body: {
        customerId: targetCustomerId,
        date: nextWeekdayDate(8),
        slotCode: '10:00',
      },
    });

    const code = createRes.data?.error?.code || createRes.data?.code || '';
    const reason = createRes.data?.error?.details?.reason;

    const ok =
      createRes.status === 201 ||
      (createRes.status === 403 && code === 'FORBIDDEN' && reason === 'feature_disabled_or_not_in_pilot') ||
      (createRes.status === 400 && code === 'VALIDATION_ERROR' && reason === 'consultation_required') ||
      (createRes.status === 403 && code === 'FORBIDDEN' && reason === 'staff_assignment_mismatch');

    if (!check('Sales direct ocular create response shape', ok, `status=${createRes.status} code=${code} reason=${reason || 'n/a'}`)) {
      failures += 1;
    }

    if (targetAppointmentId) {
      console.log(`${INFO} Running sales-staff finalize check`);
      const finalizeRes = await sales.request('POST', `/appointments/${targetAppointmentId}/finalize-ocular`, {
        body: {},
      });

      const fCode = finalizeRes.data?.error?.code || finalizeRes.data?.code || '';
      const fReason = finalizeRes.data?.error?.details?.reason;
      const okFinalize =
        finalizeRes.status === 200 ||
        (finalizeRes.status === 403 && fCode === 'FORBIDDEN' && fReason === 'feature_disabled_or_not_in_pilot') ||
        finalizeRes.status === 400;

      if (!check('Sales finalize ocular response shape', okFinalize, `status=${finalizeRes.status} code=${fCode} reason=${fReason || 'n/a'}`)) {
        failures += 1;
      }
    }
  } else {
    console.log(`${WARN} Skipping sales flow checks (need SMOKE_SALES_EMAIL/PASSWORD and SMOKE_TARGET_CUSTOMER_ID)`);
  }

  if (failures > 0) {
    console.log(`${FAIL} Direct ocular smoke test failed (${failures})`);
    process.exit(1);
  }

  console.log(`${PASS} Direct ocular smoke test passed`);
}

main().catch((err) => {
  console.error(`${FAIL} Unhandled error`, err);
  process.exit(1);
});
