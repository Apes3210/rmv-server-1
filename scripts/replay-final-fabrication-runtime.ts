import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/database.js';
import {
  FabricationUpdate,
  Project,
  User,
} from '../src/models/index.js';
import {
  FabricationStatus,
  ProjectStatus,
  Role,
} from '../src/utils/constants.js';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api/v1';

const FABRICATOR_EMAIL = 'qa.fabrication.20260310a@example.com';
const FABRICATOR_PASSWORD = 'QaFabricator@2026!';
const CUSTOMER_EMAIL = 'qa.flowdebug.475096@example.com';
const CUSTOMER_PASSWORD = 'QaFlowCustomer@2026!';
const SALES_EMAIL = 'qa.sales.20260310a@example.com';

type JsonRecord = Record<string, any>;

class Session {
  private cookies = new Map<string, string>();
  private accessToken = '';

  private cookieHeader() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private applySetCookies(res: Response) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const rawCookie of setCookies) {
      const [cookiePart] = rawCookie.split(';');
      const [name, ...valueParts] = cookiePart.split('=');
      if (!name) continue;
      this.cookies.set(name.trim(), valueParts.join('=').trim());
    }
  }

  async request(method: string, path: string, body?: JsonRecord) {
    const headers: Record<string, string> = {};
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
      headers['Content-Type'] = 'application/json';
      const csrfToken = this.cookies.get('csrfToken');
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    this.applySetCookies(res);

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status: res.status, data };
  }

  async login(email: string, password: string) {
    const csrfRes = await this.request('GET', '/csrf-token');
    if (csrfRes.status !== 200 || !this.cookies.get('csrfToken')) {
      throw new Error(`Failed to initialize CSRF for ${email}: ${csrfRes.status}`);
    }

    const loginRes = await this.request('POST', '/auth/login', { email, password });
    if (loginRes.status !== 200) {
      throw new Error(`Login failed for ${email}: ${loginRes.status} ${JSON.stringify(loginRes.data)}`);
    }

    if (loginRes.data?.data?.requires2FA) {
      throw new Error(`Login for ${email} unexpectedly requires 2FA`);
    }

    this.accessToken = loginRes.data?.data?.accessToken || '';
    if (!this.accessToken) {
      throw new Error(`Login for ${email} did not return an access token`);
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  await connectDB();

  const [fabricator, customer, sales] = await Promise.all([
    User.findOne({ email: FABRICATOR_EMAIL }).select('_id roles mustChangePassword isActive'),
    User.findOne({ email: CUSTOMER_EMAIL }).select('_id roles mustChangePassword isActive'),
    User.findOne({ email: SALES_EMAIL }).select('_id roles isActive'),
  ]);

  assert(fabricator, `Fabrication QA user not found: ${FABRICATOR_EMAIL}`);
  assert(customer, `Customer QA user not found: ${CUSTOMER_EMAIL}`);
  assert(sales, `Sales QA user not found: ${SALES_EMAIL}`);
  assert(fabricator.isActive, 'Fabrication QA user is inactive');
  assert(customer.isActive, 'Customer QA user is inactive');
  assert(sales.isActive, 'Sales QA user is inactive');
  assert(fabricator.roles.includes(Role.FABRICATION_STAFF), 'Fabrication QA user lacks fabrication_staff role');
  assert(customer.roles.includes(Role.CUSTOMER), 'Customer QA user lacks customer role');

  const now = new Date();
  const project = await Project.create({
    appointmentId: new mongoose.Types.ObjectId(),
    customerId: customer._id,
    salesStaffId: sales._id,
    engineerIds: [],
    fabricationLeadId: fabricator._id,
    fabricationAssistantIds: [],
    title: `QA Runtime Fabrication Replay ${now.toISOString()}`,
    serviceType: 'gate',
    description: 'Fresh QA project for final fabrication runtime replay.',
    siteAddress: '123 QA Runtime Street, Quezon City',
    quantity: 1,
    designReviewStatus: 'approved',
    initialDesignKeys: [],
    mediaKeys: [],
    status: ProjectStatus.FABRICATION,
    installationConfirmedAt: null,
  });

  await FabricationUpdate.create({
    projectId: project._id,
    status: FabricationStatus.READY_FOR_DELIVERY,
    notes: 'Seeded ready-for-delivery state for runtime replay.',
    updatedBy: fabricator._id,
    photoKeys: [],
  });

  const seededCount = await FabricationUpdate.countDocuments({ projectId: project._id });
  assert(seededCount === 1, `Expected 1 seeded fabrication update, got ${seededCount}`);

  const fabricatorSession = new Session();
  const customerSession = new Session();
  await fabricatorSession.login(FABRICATOR_EMAIL, FABRICATOR_PASSWORD);
  await customerSession.login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

  const blockedDone = await fabricatorSession.request('POST', '/fabrication', {
    projectId: String(project._id),
    status: FabricationStatus.DONE,
    notes: 'Attempting completion before customer confirmation.',
  });
  assert(blockedDone.status === 400, `Expected blocked done to return 400, got ${blockedDone.status}`);
  assert(
    blockedDone.data?.error?.message === 'Customer must confirm the installation schedule before marking the project as Done',
    `Unexpected blocked done error: ${JSON.stringify(blockedDone.data)}`,
  );

  const countAfterBlockedDone = await FabricationUpdate.countDocuments({ projectId: project._id });
  assert(
    countAfterBlockedDone === 1,
    `Blocked done should not persist an update. Expected count 1, got ${countAfterBlockedDone}`,
  );

  const statusAfterBlockedDone = await fabricatorSession.request('GET', `/fabrication/project/${project._id}/status`);
  assert(statusAfterBlockedDone.status === 200, `Failed to read fabrication status: ${statusAfterBlockedDone.status}`);
  assert(
    statusAfterBlockedDone.data?.data?.currentStatus === FabricationStatus.READY_FOR_DELIVERY,
    `Expected currentStatus ready_for_delivery after blocked done, got ${JSON.stringify(statusAfterBlockedDone.data)}`,
  );

  const confirmInstallation = await customerSession.request(
    'POST',
    `/projects/${project._id}/confirm-installation`,
  );
  assert(confirmInstallation.status === 200, `Expected installation confirmation 200, got ${confirmInstallation.status}`);

  const allowedDone = await fabricatorSession.request('POST', '/fabrication', {
    projectId: String(project._id),
    status: FabricationStatus.DONE,
    notes: 'Installation confirmed. Marking project as done.',
  });
  assert(allowedDone.status === 201, `Expected allowed done to return 201, got ${allowedDone.status}`);

  const [projectAfterSuccess, updatesAfterSuccess] = await Promise.all([
    Project.findById(project._id).select('status installationConfirmedAt title'),
    FabricationUpdate.find({ projectId: project._id }).sort({ createdAt: 1 }).select('status notes'),
  ]);

  assert(projectAfterSuccess, 'Project missing after successful done update');
  assert(
    projectAfterSuccess.status === ProjectStatus.COMPLETED,
    `Expected project status completed, got ${projectAfterSuccess.status}`,
  );
  assert(projectAfterSuccess.installationConfirmedAt, 'Expected installationConfirmedAt to be set');
  assert(updatesAfterSuccess.length === 2, `Expected 2 fabrication updates after success, got ${updatesAfterSuccess.length}`);
  assert(
    updatesAfterSuccess[1]?.status === FabricationStatus.DONE,
    `Expected latest fabrication update to be done, got ${updatesAfterSuccess[1]?.status}`,
  );

  console.log(JSON.stringify({
    success: true,
    projectId: String(project._id),
    title: projectAfterSuccess.title,
    blockedDoneStatus: blockedDone.status,
    blockedDoneMessage: blockedDone.data?.error?.message,
    statusAfterBlockedDone: statusAfterBlockedDone.data?.data?.currentStatus,
    confirmInstallationStatus: confirmInstallation.status,
    allowedDoneStatus: allowedDone.status,
    finalProjectStatus: projectAfterSuccess.status,
    fabricationStatuses: updatesAfterSuccess.map((update) => update.status),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });