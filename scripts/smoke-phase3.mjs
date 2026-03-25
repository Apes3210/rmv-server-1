/**
 * Phase 3 API smoke test for newly added operational safeguards.
 *
 * Usage:
 *   node scripts/smoke-phase3.mjs
 *
 * Environment variables:
 *   SMOKE_BASE_URL (default: http://localhost:5000/api/v1)
 *   SMOKE_ADMIN_EMAIL (default: admin@rmvsteelfab.com)
 *   SMOKE_ADMIN_PASSWORD (default: Admin@12345)
 *   SMOKE_PHASE3_KEY (default: smoke_phase3_probe)
 *   SMOKE_PHASE3_STRICT (default: false)
 *   SMOKE_ALLOW_MUTATIONS (default: false)
 *   SMOKE_REFUND_ID (optional explicit refund id for dispatch/reconcile)
 *   SMOKE_PAYMENT_ID (optional explicit payment id for evidence-trail)
 */

import mongoose from 'mongoose';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api/v1';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || 'admin@rmvsteelfab.com';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || 'Admin@12345';
const PHASE3_KEY = process.env.SMOKE_PHASE3_KEY || 'smoke_phase3_probe';
const EXPLICIT_PAYMENT_ID = process.env.SMOKE_PAYMENT_ID || '';
const STRICT = String(process.env.SMOKE_PHASE3_STRICT || '').toLowerCase() === 'true';
const ALLOW_MUTATIONS = String(process.env.SMOKE_ALLOW_MUTATIONS || '').toLowerCase() === 'true';
const MONGODB_URI = process.env.MONGODB_URI || '';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';

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

    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    if (this.refreshToken) {
      headers['X-Refresh-Token'] = this.refreshToken;
    }

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
      // Ignore non-JSON body.
    }

    return { status: res.status, data, headers: res.headers };
  }
}

function assertCheck(name, condition, details = '') {
  if (condition) {
    console.log(`${PASS} ${name}`);
    return true;
  }
  console.log(`${FAIL} ${name}${details ? `: ${details}` : ''}`);
  return false;
}

function skipStep(name, details = '') {
  console.log(`${SKIP} ${name}${details ? `: ${details}` : ''}`);
}

function info(name, details = '') {
  console.log(`${INFO} ${name}${details ? `: ${details}` : ''}`);
}

async function loginAsAdmin(session, failures) {
  const csrfRes = await session.request('GET', '/csrf-token');
  if (!assertCheck('CSRF token endpoint', csrfRes.status === 200, `status=${csrfRes.status}`)) {
    failures.push('csrf-token');
    return false;
  }

  const loginRes = await session.request('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  session.accessToken = loginRes.data?.data?.accessToken || null;
  session.refreshToken = loginRes.data?.data?.refreshToken || null;

  if (!assertCheck('Admin login', loginRes.status === 200 && !!session.accessToken, `status=${loginRes.status}`)) {
    failures.push('admin-login');
    return false;
  }

  return true;
}

async function smokeConfigSafety(session, failures) {
  const previewRes = await session.request('POST', '/config/configs/maintenance_mode/preview', {
    body: { value: true },
  });
  if (
    !assertCheck(
      'Config impact preview endpoint',
      previewRes.status === 200 && typeof previewRes.data?.data?.riskLevel === 'string',
      `status=${previewRes.status}`,
    )
  ) {
    failures.push('config-preview');
  }

  const firstWrite = await session.request('PUT', `/config/configs/${encodeURIComponent(PHASE3_KEY)}`, {
    body: { value: { marker: 'v1', at: new Date().toISOString() }, description: 'Phase 3 smoke seed v1' },
  });
  if (!assertCheck('Config update v1', firstWrite.status === 200, `status=${firstWrite.status}`)) {
    failures.push('config-upsert-v1');
    return;
  }

  const secondWrite = await session.request('PUT', `/config/configs/${encodeURIComponent(PHASE3_KEY)}`, {
    body: { value: { marker: 'v2', at: new Date().toISOString() }, description: 'Phase 3 smoke seed v2' },
  });
  if (!assertCheck('Config update v2', secondWrite.status === 200, `status=${secondWrite.status}`)) {
    failures.push('config-upsert-v2');
    return;
  }

  const versionsRes = await session.request('GET', `/config/configs/${encodeURIComponent(PHASE3_KEY)}/versions`);
  const versions = versionsRes.data?.data?.versions || [];
  if (
    !assertCheck(
      'Config versions endpoint',
      versionsRes.status === 200 && Array.isArray(versions) && versions.length > 0,
      `status=${versionsRes.status}`,
    )
  ) {
    failures.push('config-versions');
    return;
  }

  const versionId = versions[0]?._id;
  if (!versionId) {
    failures.push('config-version-id');
    console.log(`${FAIL} Config rollback precondition: missing version id`);
    return;
  }

  const rollbackRes = await session.request('POST', `/config/configs/${encodeURIComponent(PHASE3_KEY)}/rollback`, {
    body: { versionId },
  });
  if (!assertCheck('Config rollback endpoint', rollbackRes.status === 200, `status=${rollbackRes.status}`)) {
    failures.push('config-rollback');
  }
}

async function smokePaymentEvidenceTrail(session, failures) {
  let paymentId = EXPLICIT_PAYMENT_ID;

  if (paymentId) {
    info('Payment evidence fixture', `Using SMOKE_PAYMENT_ID=${paymentId}`);
  }

  const pendingRes = await session.request('GET', '/payments/pending?limit=1');
  if (pendingRes.status !== 200) {
    failures.push('payments-pending');
    console.log(`${FAIL} Payments pending list endpoint: status=${pendingRes.status}`);
    return;
  }

  if (!paymentId) {
    const firstPayment = pendingRes.data?.data?.[0] || null;
    paymentId = firstPayment?._id || '';
  }

  if (!paymentId) {
    const dbIds = await findFixtureIdsFromMongo();
    paymentId = dbIds.paymentId || '';
  }

  if (!paymentId) {
    skipStep('Payment evidence trail positive check', 'No pending payment found in this environment');
    if (STRICT) failures.push('payment-evidence-skipped');
    return;
  }

  const evidenceRes = await session.request('GET', `/payments/${paymentId}/evidence-trail`);
  if (
    !assertCheck(
      'Payment evidence trail endpoint',
      evidenceRes.status === 200 && Array.isArray(evidenceRes.data?.data?.evidenceTrail),
      `status=${evidenceRes.status}`,
    )
  ) {
    failures.push('payment-evidence-trail');
  }
}

async function smokeRefundDispatchAndReconcile(session, failures) {
  let refundId = process.env.SMOKE_REFUND_ID || '';

  if (!refundId) {
    const approvedRes = await session.request('GET', '/refunds?status=approved&limit=1');
    if (approvedRes.status !== 200) {
      failures.push('refunds-approved-list');
      console.log(`${FAIL} Refund approved list endpoint: status=${approvedRes.status}`);
      return;
    }
    refundId = approvedRes.data?.data?.requests?.[0]?._id || '';

    if (!refundId) {
      const pendingRes = await session.request('GET', '/refunds?status=pending&limit=1');
      if (pendingRes.status === 200) {
        const pendingId = pendingRes.data?.data?.requests?.[0]?._id || '';
        if (pendingId && ALLOW_MUTATIONS) {
          const approveRes = await session.request('POST', `/refunds/${pendingId}/approve`);
          if (approveRes.status === 200) {
            refundId = pendingId;
            info('Refund fixture', `Promoted pending refund to approved: ${pendingId}`);
          }
        }
      }
    }

    if (!refundId) {
      const dbIds = await findFixtureIdsFromMongo();
      refundId = dbIds.approvedRefundId || '';
    }

    if (!refundId && ALLOW_MUTATIONS) {
      refundId = await createApprovedRefundFixtureFromMongo();
      if (refundId) {
        info('Refund fixture', `Created approved smoke refund: ${refundId}`);
      }
    }
  }

  if (!refundId) {
    skipStep('Refund dispatch/reconcile', 'No approved refund available and no SMOKE_REFUND_ID provided');
    if (STRICT) failures.push('refund-dispatch-reconcile-skipped');
    return;
  }

  if (!ALLOW_MUTATIONS) {
    skipStep('Refund dispatch/reconcile', 'Set SMOKE_ALLOW_MUTATIONS=true to run mutating refund checks');
    if (STRICT) failures.push('refund-dispatch-reconcile-skipped');
    return;
  }

  const refNumber = `SMOKE-${Date.now()}`;
  const dispatchRes = await session.request('POST', `/refunds/${refundId}/dispatch`, {
    body: { referenceNumber: refNumber, note: 'Phase 3 smoke dispatch check' },
  });
  if (!assertCheck('Refund dispatch endpoint', dispatchRes.status === 200, `status=${dispatchRes.status}`)) {
    failures.push('refund-dispatch');
    return;
  }

  const reconcileRes = await session.request('POST', `/refunds/${refundId}/reconcile`, {
    body: { note: 'Phase 3 smoke reconciliation check' },
  });
  if (!assertCheck('Refund reconcile endpoint', reconcileRes.status === 200, `status=${reconcileRes.status}`)) {
    failures.push('refund-reconcile');
  }
}

async function main() {
  const failures = [];
  const session = new Session();

  info('Base URL', BASE_URL);
  info('Strict mode', String(STRICT));
  info('Mutations enabled', String(ALLOW_MUTATIONS));

  const loggedIn = await loginAsAdmin(session, failures);
  if (!loggedIn) {
    console.log(`${FAIL} Cannot continue without admin session`);
    process.exit(1);
  }

  await smokeConfigSafety(session, failures);
  await smokePaymentEvidenceTrail(session, failures);
  await smokeRefundDispatchAndReconcile(session, failures);

  console.log('');
  if (failures.length) {
    console.log(`${FAIL} Phase 3 smoke failed (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log(`${PASS} Phase 3 smoke passed`);
}

async function findFixtureIdsFromMongo() {
  if (!MONGODB_URI) return { paymentId: '', approvedRefundId: '' };

  let connected = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      connected = true;
    }

    const [paymentDoc, approvedRefundDoc] = await Promise.all([
      mongoose.connection.db.collection('payments').findOne({}, { projection: { _id: 1 } }),
      mongoose.connection.db.collection('refundrequests').findOne(
        { status: 'approved' },
        { projection: { _id: 1 } },
      ),
    ]);

    return {
      paymentId: paymentDoc?._id?.toString() || '',
      approvedRefundId: approvedRefundDoc?._id?.toString() || '',
    };
  } catch {
    return { paymentId: '', approvedRefundId: '' };
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
  }
}

async function createApprovedRefundFixtureFromMongo() {
  if (!MONGODB_URI) return '';

  let connected = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      connected = true;
    }

    const now = new Date();
    const oid = () => new mongoose.Types.ObjectId();
    const doc = {
      appointmentId: oid(),
      customerId: oid(),
      reason: 'Phase 3 smoke fixture refund',
      refundMethod: 'gcash',
      accountName: 'Smoke Fixture',
      accountNumber: '09990000000',
      amount: 1,
      status: 'approved',
      reviewedBy: oid(),
      reviewedAt: now,
      dispatchTrail: [
        {
          event: 'approved',
          at: now,
          note: 'Auto-created fixture for smoke validation',
          amount: 1,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const insertRes = await mongoose.connection.db.collection('refundrequests').insertOne(doc);
    return insertRes.insertedId?.toString() || '';
  } catch {
    return '';
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(`${FAIL} Unhandled error`, err);
  process.exit(1);
});
