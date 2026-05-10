import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  Appointment,
  AuditLog,
  Blueprint,
  CashCollection,
  FabricationItem,
  FabricationUpdate,
  Notification,
  Payment,
  PaymentPlan,
  Project,
  ProjectItem,
  User,
  VisitReport,
  VisitReportStatus,
} from '../models/index.js';
import {
  AppointmentAttendanceStatus,
  AppointmentStatus,
  AppointmentType,
  AuditAction,
  BlueprintStatus,
  CashCollectionStatus,
  ContractStatus,
  Environment,
  FabricationStatus,
  MeasurementUnit,
  NotificationCategory,
  PaymentMethod,
  PaymentStageStatus,
  ProjectStatus,
  Role,
  ServiceType,
  type SlotCode,
} from '../utils/constants.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'rmv-uploads';

if (!MONGODB_URI) throw new Error('MONGODB_URI is required');
const mongoUri = MONGODB_URI;

type StaffKey = 'admin' | 'agent' | 'sales' | 'engineer' | 'cashier' | 'fabricator';

interface DemoWorkflow {
  code: string;
  customerKey: string;
  customer: { firstName: string; lastName: string; city: string; address: string };
  appointmentType: AppointmentType;
  appointmentDate: string;
  slotCode: SlotCode;
  bookedAt: string;
  confirmedAt: string;
  reportAt?: string;
  blueprintAt?: string;
  paymentAt?: string;
  fabricationDates?: string[];
  completedAt?: string;
  serviceType: ServiceType;
  title: string;
  address: string;
  totalCost: number;
  status: ProjectStatus;
  finalAppointmentStatus?: AppointmentStatus;
  attendanceStatus?: AppointmentAttendanceStatus;
  notes?: string;
}

const workflows: DemoWorkflow[] = [
  {
    code: 'P001',
    customerKey: 'customer-ramos',
    customer: { firstName: 'Carlo', lastName: 'Ramos', city: 'Quezon City', address: 'Project 4, Quezon City' },
    appointmentType: AppointmentType.OFFICE,
    appointmentDate: '2026-01-08',
    slotCode: '10:00',
    bookedAt: '2026-01-04',
    confirmedAt: '2026-01-05',
    reportAt: '2026-01-08',
    blueprintAt: '2026-01-11',
    paymentAt: '2026-01-13',
    fabricationDates: ['2026-01-16', '2026-01-20', '2026-01-25'],
    completedAt: '2026-01-29',
    serviceType: ServiceType.GATES,
    title: 'Residential Stainless Main Gate',
    address: 'Project 4, Quezon City',
    totalCost: 88000,
    status: ProjectStatus.COMPLETED,
  },
  {
    code: 'P002',
    customerKey: 'customer-lopez',
    customer: { firstName: 'Mara', lastName: 'Lopez', city: 'Makati', address: 'Poblacion, Makati' },
    appointmentType: AppointmentType.OCULAR,
    appointmentDate: '2026-01-23',
    slotCode: '13:00',
    bookedAt: '2026-01-17',
    confirmedAt: '2026-01-18',
    reportAt: '2026-01-23',
    blueprintAt: '2026-01-27',
    paymentAt: '2026-01-31',
    fabricationDates: ['2026-02-05', '2026-02-11', '2026-02-18'],
    completedAt: '2026-02-22',
    serviceType: ServiceType.RAILINGS,
    title: 'Balcony Railings Upgrade',
    address: 'Poblacion, Makati',
    totalCost: 64000,
    status: ProjectStatus.COMPLETED,
  },
  {
    code: 'P003',
    customerKey: 'customer-tan',
    customer: { firstName: 'Rico', lastName: 'Tan', city: 'Pasig', address: 'Kapitolyo, Pasig' },
    appointmentType: AppointmentType.OFFICE,
    appointmentDate: '2026-02-06',
    slotCode: '11:00',
    bookedAt: '2026-02-01',
    confirmedAt: '2026-02-02',
    reportAt: '2026-02-06',
    blueprintAt: '2026-02-10',
    paymentAt: '2026-02-14',
    fabricationDates: ['2026-02-20', '2026-02-27', '2026-03-08'],
    completedAt: '2026-03-14',
    serviceType: ServiceType.KITCHEN_COUNTER,
    title: 'Stainless Kitchen Counter System',
    address: 'Kapitolyo, Pasig',
    totalCost: 112000,
    status: ProjectStatus.COMPLETED,
  },
  {
    code: 'P004',
    customerKey: 'customer-cruz',
    customer: { firstName: 'Ivy', lastName: 'Cruz', city: 'Taguig', address: 'BGC, Taguig' },
    appointmentType: AppointmentType.OCULAR,
    appointmentDate: '2026-02-21',
    slotCode: '15:00',
    bookedAt: '2026-02-15',
    confirmedAt: '2026-02-16',
    reportAt: '2026-02-21',
    blueprintAt: '2026-02-25',
    paymentAt: '2026-03-02',
    fabricationDates: ['2026-03-09', '2026-03-18'],
    serviceType: ServiceType.CANOPY,
    title: 'Outdoor Stainless Canopy',
    address: 'BGC, Taguig',
    totalCost: 73000,
    status: ProjectStatus.FABRICATION,
  },
  {
    code: 'P005',
    customerKey: 'customer-villanueva',
    customer: { firstName: 'Anne', lastName: 'Villanueva', city: 'Mandaluyong', address: 'Plainview, Mandaluyong' },
    appointmentType: AppointmentType.OFFICE,
    appointmentDate: '2026-03-05',
    slotCode: '14:00',
    bookedAt: '2026-02-28',
    confirmedAt: '2026-03-01',
    reportAt: '2026-03-05',
    blueprintAt: '2026-03-10',
    paymentAt: '2026-03-12',
    serviceType: ServiceType.STAIRCASE,
    title: 'Indoor Stainless Staircase',
    address: 'Plainview, Mandaluyong',
    totalCost: 158000,
    status: ProjectStatus.PAYMENT_PENDING,
  },
];

const edgeAppointments = [
  {
    customerKey: 'customer-sy',
    customer: { firstName: 'Derek', lastName: 'Sy', city: 'San Juan', address: 'Greenhills, San Juan' },
    date: '2026-03-12',
    slotCode: '09:00' as SlotCode,
    status: AppointmentStatus.CONFIRMED,
    attendanceStatus: AppointmentAttendanceStatus.SCHEDULED,
    notes: 'DEMO: Upcoming confirmed ocular visit waiting for attendance.',
  },
  {
    customerKey: 'customer-lim',
    customer: { firstName: 'Patricia', lastName: 'Lim', city: 'Manila', address: 'Sampaloc, Manila' },
    date: '2026-03-16',
    slotCode: '16:00' as SlotCode,
    status: AppointmentStatus.NO_SHOW,
    attendanceStatus: AppointmentAttendanceStatus.NO_SHOW,
    notes: 'DEMO: Customer did not arrive for consultation.',
  },
  {
    customerKey: 'customer-go',
    customer: { firstName: 'Elaine', lastName: 'Go', city: 'Paranaque', address: 'BF Homes, Paranaque' },
    date: '2026-03-22',
    slotCode: '10:00' as SlotCode,
    status: AppointmentStatus.CANCELLED,
    attendanceStatus: AppointmentAttendanceStatus.CUSTOMER_DECLINED,
    notes: 'DEMO: Customer declined during consultation and chose not to proceed.',
  },
];

function dateAt(date: string, hour = 10, minute = 0): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
}

function email(handle: string) {
  return `${handle}@demo.rmv.local`;
}

function r2Client(): S3Client | null {
  if (!R2_ACCOUNT_ID || R2_ACCOUNT_ID === 'placeholder' || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

async function uploadDemoObject(client: S3Client | null, key: string, body: string) {
  if (!client) return;
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'text/plain',
  }));
}

async function clearExistingDemoData() {
  const demoUsers = await User.find({ email: /@demo\.rmv\.local$/i }).select('_id').lean();
  const demoUserIds = demoUsers.map((u) => u._id);
  const demoProjects = await Project.find({ projectNumber: /^DEMO-2026-/ }).select('_id').lean();
  const demoProjectIds = demoProjects.map((p) => p._id);
  const demoAppointments = await Appointment.find({ customerNotes: /^DEMO:/ }).select('_id').lean();
  const demoAppointmentIds = demoAppointments.map((a) => a._id);

  await Promise.all([
    Notification.deleteMany({ userId: { $in: demoUserIds } }),
    AuditLog.deleteMany({ $or: [{ actorId: { $in: demoUserIds } }, { 'details.demo': true }] }),
    FabricationUpdate.deleteMany({ $or: [{ projectId: { $in: demoProjectIds } }, { notes: /^DEMO:/ }] }),
    FabricationItem.deleteMany({ $or: [{ projectId: { $in: demoProjectIds } }, { workerNotes: /^DEMO:/ }] }),
    Blueprint.deleteMany({ $or: [{ projectId: { $in: demoProjectIds } }, { blueprintKey: /^demo\// }] }),
    Payment.deleteMany({ $or: [{ projectId: { $in: demoProjectIds } }, { referenceNumber: /^DEMO-/ }] }),
    PaymentPlan.deleteMany({ $or: [{ projectId: { $in: demoProjectIds } }, { createdBy: { $in: demoUserIds } }] }),
    ProjectItem.deleteMany({ projectId: { $in: demoProjectIds } }),
    VisitReport.deleteMany({
      $or: [
        { appointmentId: { $in: demoAppointmentIds } },
        { linkedProjectId: { $in: demoProjectIds } },
        { notes: /^DEMO:/ },
        { discussionNotes: /^DEMO:/ },
      ],
    }),
    CashCollection.deleteMany({ $or: [{ appointmentId: { $in: demoAppointmentIds } }, { notes: /^DEMO:/ }] }),
  ]);

  await Project.deleteMany({ _id: { $in: demoProjectIds } });
  await Appointment.deleteMany({ _id: { $in: demoAppointmentIds } });
  await User.deleteMany({ _id: { $in: demoUserIds } });
}

async function seedUsers() {
  const password = await bcrypt.hash('Demo@12345', 10);
  const base = {
    password,
    isEmailVerified: true,
    isActive: true,
    mustChangePassword: false,
    provider: 'local',
    notificationPreferences: {
      appointment: true,
      payment: true,
      blueprint: true,
      fabrication: true,
      project: true,
      emailNotifications: true,
    },
    themePreference: 'light',
  };

  const staff: Array<{ key: StaffKey; firstName: string; lastName: string; roles: Role[]; phone: string; signatureKey?: string }> = [
    { key: 'admin', firstName: 'Andrea', lastName: 'Mercado', roles: [Role.ADMIN], phone: '09170000001' },
    { key: 'agent', firstName: 'Miguel', lastName: 'Santos', roles: [Role.APPOINTMENT_AGENT], phone: '09170000002' },
    { key: 'sales', firstName: 'Paulo', lastName: 'Reyes', roles: [Role.SALES_STAFF], phone: '09170000003' },
    { key: 'engineer', firstName: 'Lara', lastName: 'Dizon', roles: [Role.ENGINEER], phone: '09170000004' },
    { key: 'cashier', firstName: 'Nina', lastName: 'Flores', roles: [Role.CASHIER], phone: '09170000005', signatureKey: 'demo/signatures/cashier-nina.txt' },
    { key: 'fabricator', firstName: 'Jose', lastName: 'Valdez', roles: [Role.FABRICATION_STAFF], phone: '09170000006' },
  ];

  const customerRecords = [...workflows, ...edgeAppointments].map((item, index) => ({
    email: email(item.customerKey),
    firstName: item.customer.firstName,
    lastName: item.customer.lastName,
    phone: `09171234${String(index + 1).padStart(3, '0')}`,
    roles: [Role.CUSTOMER],
    addressData: {
      city: item.customer.city,
      province: 'Metro Manila',
      country: 'Philippines',
      formattedAddress: item.customer.address,
      isDefault: true,
    },
    savedAddresses: [{
      id: `${item.customerKey}-site`,
      label: 'Project Site',
      city: item.customer.city,
      province: 'Metro Manila',
      country: 'Philippines',
      formattedAddress: item.customer.address,
      isDefault: true,
    }],
    createdAt: dateAt(index < 4 ? '2026-01-03' : '2026-02-01', 9),
    updatedAt: dateAt('2026-03-22', 16),
  }));

  const inserted = await User.insertMany([
    ...staff.map((user, index) => ({
      ...base,
      email: email(user.key),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      roles: user.roles,
      signatureKey: user.signatureKey,
      createdAt: dateAt('2026-01-02', 8 + index),
      updatedAt: dateAt('2026-03-22', 15),
    })),
    ...customerRecords.map((user) => ({ ...base, ...user })),
  ]);

  return new Map(inserted.map((user) => [user.email, user]));
}

async function seedWorkflow(workflow: DemoWorkflow, users: Awaited<ReturnType<typeof seedUsers>>, uploads: Set<string>) {
  const admin = users.get(email('admin'))!;
  const agent = users.get(email('agent'))!;
  const sales = users.get(email('sales'))!;
  const engineer = users.get(email('engineer'))!;
  const cashier = users.get(email('cashier'))!;
  const fabricator = users.get(email('fabricator'))!;
  const customer = users.get(email(workflow.customerKey))!;
  const projectNumber = `DEMO-2026-${workflow.code.replace('P', '').padStart(4, '0')}`;

  const appointment = await Appointment.create({
    customerId: customer._id,
    type: workflow.appointmentType,
    date: workflow.appointmentDate,
    slotCode: workflow.slotCode,
    status: AppointmentStatus.COMPLETED,
    attendanceStatus: AppointmentAttendanceStatus.COMPLETED,
    actualArrivalAt: dateAt(workflow.appointmentDate, 10, 2),
    consultationStartedAt: dateAt(workflow.appointmentDate, 10, 8),
    consultationCompletedAt: dateAt(workflow.appointmentDate, 10, 55),
    attendanceNotes: `DEMO: ${workflow.title} consultation completed.`,
    attendanceUpdatedBy: sales._id,
    attendanceUpdatedAt: dateAt(workflow.appointmentDate, 11),
    salesStaffId: sales._id,
    formattedAddress: workflow.address,
    customerAddress: workflow.address,
    serviceTypes: [workflow.serviceType],
    customerNotes: `DEMO: Booking request for ${workflow.title}.`,
    internalNotes: 'DEMO: Agent confirmed schedule and assigned sales staff.',
    bookedBy: customer._id,
    confirmedBy: agent._id,
    ocularFee: workflow.appointmentType === AppointmentType.OCULAR ? 1500 : undefined,
    ocularFeePaymentMethod: workflow.appointmentType === AppointmentType.OCULAR ? PaymentMethod.CASH : undefined,
    ocularFeePaymentChoice: workflow.appointmentType === AppointmentType.OCULAR ? 'cash' : undefined,
    ocularFeeStatus: workflow.appointmentType === AppointmentType.OCULAR ? 'verified' : undefined,
    ocularFeePaid: workflow.appointmentType === AppointmentType.OCULAR ? true : undefined,
    createdAt: dateAt(workflow.bookedAt, 9),
    updatedAt: dateAt(workflow.appointmentDate, 11),
  });

  const report = await VisitReport.create({
    appointmentId: appointment._id,
    customerId: customer._id,
    salesStaffId: sales._id,
    status: VisitReportStatus.COMPLETED,
    visitType: workflow.appointmentType === AppointmentType.OCULAR ? 'ocular' : 'consultation',
    actualVisitDateTime: dateAt(workflow.reportAt || workflow.appointmentDate, 10, 10),
    serviceType: workflow.serviceType,
    measurementUnit: MeasurementUnit.CM,
    lineItems: [
      { label: `${workflow.title} main section`, length: 220, height: 180, thickness: 1.2, quantity: 1, notes: 'Primary fabrication component.' },
      { label: 'Support fittings', length: 80, height: 40, thickness: 1, quantity: 2, notes: 'Mounting and support hardware.' },
    ],
    measurements: { length: 220, height: 180, thickness: 1.2, unit: 'cm' },
    siteConditions: {
      environment: workflow.appointmentType === AppointmentType.OCULAR ? Environment.OUTDOOR : Environment.INDOOR,
      floorType: 'Concrete',
      wallMaterial: 'Concrete hollow block',
      hasElectrical: true,
      hasPlumbing: false,
      accessNotes: 'Normal access, daytime work preferred.',
    },
    materials: '304 stainless steel',
    finishes: 'Brushed stainless finish',
    preferredDesign: 'Clean modern profile with durable welds.',
    customerRequirements: 'Durable fabrication with clean finish and clear project timeline.',
    notes: `DEMO: Visit report completed for ${workflow.title}.`,
    discussionNotes: `DEMO: Scope, measurements, materials, expected timeline, and budget discussed.`,
    consultationOutcome: 'no_ocular',
    photoKeys: [`demo/visit-reports/${workflow.code.toLowerCase()}-site-photo.txt`],
    sketchKeys: [`demo/visit-reports/${workflow.code.toLowerCase()}-sketch.txt`],
    referenceImageKeys: [`demo/visit-reports/${workflow.code.toLowerCase()}-reference.txt`],
    createdAt: dateAt(workflow.reportAt || workflow.appointmentDate, 11),
    updatedAt: dateAt(workflow.reportAt || workflow.appointmentDate, 12),
  });

  const project = await Project.create({
    appointmentId: appointment._id,
    projectNumber,
    visitReportId: report._id,
    customerId: customer._id,
    salesStaffId: sales._id,
    engineerIds: [engineer._id],
    fabricationLeadId: workflow.status === ProjectStatus.PAYMENT_PENDING ? undefined : fabricator._id,
    fabricationAssistantIds: [],
    title: workflow.title,
    totalCost: workflow.totalCost,
    serviceType: workflow.serviceType,
    serviceTypes: [workflow.serviceType],
    description: `DEMO: ${workflow.title} from booking through ${workflow.status}.`,
    siteAddress: workflow.address,
    measurements: { length: 220, height: 180, thickness: 1.2, unit: 'cm' },
    materialType: '304 stainless steel',
    finishColor: 'Brushed stainless',
    quantity: 1,
    notes: `DEMO: Project created from completed ${workflow.appointmentType} workflow.`,
    estimatedCompletionDate: workflow.completedAt ? dateAt(workflow.completedAt, 17) : dateAt('2026-03-30', 17),
    initialDesignKeys: [`demo/designs/${workflow.code.toLowerCase()}-initial-design.txt`],
    initialDesignNotes: 'Initial design approved for engineering draft.',
    designReviewStatus: 'approved',
    designReviewedBy: customer._id,
    designReviewedAt: workflow.blueprintAt ? dateAt(workflow.blueprintAt, 16) : undefined,
    status: workflow.status,
    mediaKeys: [`demo/projects/${workflow.code.toLowerCase()}-site-photo.txt`],
    contractStatus: ContractStatus.UPLOADED,
    contractFileKey: `demo/contracts/${workflow.code.toLowerCase()}-signed-contract.txt`,
    contractFileName: `${projectNumber}-signed-contract.txt`,
    contractContentType: 'text/plain',
    contractFileSize: 512,
    contractUploadedAt: workflow.paymentAt ? dateAt(workflow.paymentAt, 9) : undefined,
    contractUploadedBy: cashier._id,
    contractSignedAt: workflow.paymentAt ? dateAt(workflow.paymentAt, 9, 30) : undefined,
    installationConfirmedAt: workflow.completedAt ? dateAt(workflow.completedAt, 15) : undefined,
    customerReview: workflow.completedAt ? {
      rating: workflow.code === 'P003' ? 4 : 5,
      comment: 'Demo review: output was inspected and accepted.',
      submittedAt: dateAt(workflow.completedAt, 16),
      submittedBy: customer._id,
    } : undefined,
    createdAt: dateAt(workflow.reportAt || workflow.appointmentDate, 13),
    updatedAt: workflow.completedAt ? dateAt(workflow.completedAt, 16) : dateAt('2026-03-20', 16),
  });

  const item = await ProjectItem.create({
    projectId: project._id,
    appointmentId: appointment._id,
    consultationVisitReportId: report._id,
    ocularVisitReportId: workflow.appointmentType === AppointmentType.OCULAR ? report._id : undefined,
    serviceType: workflow.serviceType,
    title: workflow.title,
    status: workflow.status,
    measurements: { length: 220, height: 180, thickness: 1.2, unit: 'cm' },
    measurementUnit: MeasurementUnit.CM,
    lineItems: report.lineItems,
    materials: '304 stainless steel',
    finishes: 'Brushed stainless finish',
    preferredDesign: 'Modern low-maintenance stainless build.',
    customerRequirements: 'Stable, clean, and corrosion-resistant output.',
    notes: `DEMO: Work item for ${workflow.title}.`,
    initialDesignKeys: [`demo/designs/${workflow.code.toLowerCase()}-initial-design.txt`],
    initialDesignNotes: 'Customer accepted initial design direction.',
    designReviewStatus: 'approved',
    designReviewedBy: customer._id,
    designReviewedAt: workflow.blueprintAt ? dateAt(workflow.blueprintAt, 16) : undefined,
    installationConfirmedAt: workflow.completedAt ? dateAt(workflow.completedAt, 15) : undefined,
    mediaKeys: [`demo/projects/${workflow.code.toLowerCase()}-site-photo.txt`],
    createdAt: dateAt(workflow.reportAt || workflow.appointmentDate, 14),
    updatedAt: workflow.completedAt ? dateAt(workflow.completedAt, 15) : dateAt('2026-03-20', 16),
  });

  report.linkedProjectId = project._id;
  report.projectItemId = item._id;
  await report.save();

  if (workflow.blueprintAt) {
    await Blueprint.create({
      projectId: project._id,
      projectItemId: item._id,
      version: 1,
      status: BlueprintStatus.APPROVED,
      blueprintKey: `demo/blueprints/${workflow.code.toLowerCase()}-blueprint.txt`,
      designKey: `demo/blueprints/${workflow.code.toLowerCase()}-design.txt`,
      costingKey: `demo/blueprints/${workflow.code.toLowerCase()}-costing.txt`,
      blueprintApproved: true,
      costingApproved: true,
      uploadedBy: engineer._id,
      quotationReviewStatus: 'sent_to_customer',
      quotationReviewedBy: admin._id,
      quotationReviewedAt: dateAt(workflow.blueprintAt, 13),
      quotationSentAt: dateAt(workflow.blueprintAt, 15),
      quotation: {
        total: workflow.totalCost,
        subtotal: workflow.totalCost,
        paymentOption: workflow.status === ProjectStatus.PAYMENT_PENDING ? 'milestone' : 'milestone',
        paymentMilestones: [
          { label: 'Down Payment', percentage: 30, amount: workflow.totalCost * 0.3, trigger: 'Before procurement' },
          { label: 'Mid Project', percentage: 40, amount: workflow.totalCost * 0.4, trigger: 'During fabrication' },
          { label: 'Final Payment', percentage: 30, amount: workflow.totalCost * 0.3, trigger: 'Before release' },
        ],
        inclusions: 'Materials, fabrication labor, basic installation, and finishing.',
        exclusions: 'Major civil works and electrical relocation.',
        engineerNotes: 'DEMO: Quotation reviewed and sent to customer.',
        lineItems: [
          { label: 'Materials', quantity: 1, materials: workflow.totalCost * 0.52, labor: 0, amount: workflow.totalCost * 0.52 },
          { label: 'Fabrication and installation', quantity: 1, materials: 0, labor: workflow.totalCost * 0.48, amount: workflow.totalCost * 0.48 },
        ],
      },
      createdAt: dateAt(workflow.blueprintAt, 10),
      updatedAt: dateAt(workflow.blueprintAt, 15),
    });
  }

  if (workflow.paymentAt) {
    const stages = [
      { stageId: `${workflow.code}-S1`, label: 'Down Payment', percentage: 30, amount: workflow.totalCost * 0.3 },
      { stageId: `${workflow.code}-S2`, label: 'Mid Project', percentage: 40, amount: workflow.totalCost * 0.4 },
      { stageId: `${workflow.code}-S3`, label: 'Final Payment', percentage: 30, amount: workflow.totalCost * 0.3 },
    ];
    const paidStageCount = workflow.status === ProjectStatus.COMPLETED ? 3 : workflow.status === ProjectStatus.FABRICATION ? 2 : 0;

    await PaymentPlan.create({
      projectId: project._id,
      projectItemId: item._id,
      totalAmount: workflow.totalCost,
      isPayInFull: false,
      isImmutable: paidStageCount > 0,
      createdBy: cashier._id,
      stages: stages.map((stage, index) => ({
        ...stage,
        description: index === 0 ? 'Before procurement starts' : index === 1 ? 'Before mid-project fabrication continues' : 'Before delivery/release',
        status: index < paidStageCount ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING,
        amountPaid: index < paidStageCount ? stage.amount : 0,
        creditApplied: 0,
        remainingBalance: index < paidStageCount ? 0 : stage.amount,
        activatedAt: index <= paidStageCount ? dateAt(workflow.paymentAt!, 9 + index) : null,
        headsUpSentAt: index > paidStageCount ? dateAt(workflow.paymentAt!, 8) : null,
        remindersSent: 0,
        escalatedToCashier: false,
      })),
      createdAt: dateAt(workflow.paymentAt, 9),
      updatedAt: dateAt(workflow.paymentAt, 16),
    });

    for (let i = 0; i < paidStageCount; i += 1) {
      const stage = stages[i]!;
      const paidAt = dateAt(workflow.paymentAt, 10 + i);
      await Payment.create({
        projectId: project._id,
        projectItemId: item._id,
        stageId: stage.stageId,
        method: i === 0 ? PaymentMethod.BANK_TRANSFER : i === 1 ? PaymentMethod.GCASH : PaymentMethod.CASH,
        amountPaid: stage.amount,
        referenceNumber: `DEMO-${workflow.code}-PAY-${i + 1}`,
        proofKey: `demo/payments/${workflow.code.toLowerCase()}-stage-${i + 1}-proof.txt`,
        status: PaymentStageStatus.VERIFIED,
        verifiedBy: cashier._id,
        verifiedAt: paidAt,
        cashierSignatureKey: 'demo/signatures/cashier-nina.txt',
        receiptKey: `demo/receipts/${workflow.code.toLowerCase()}-stage-${i + 1}-receipt.txt`,
        receiptNumber: `DEMO-RCPT-${workflow.code}-${i + 1}`,
        evidenceTrail: [{
          version: 1,
          source: 'demo-seed',
          status: PaymentStageStatus.VERIFIED,
          method: i === 0 ? PaymentMethod.BANK_TRANSFER : i === 1 ? PaymentMethod.GCASH : PaymentMethod.CASH,
          amountPaid: stage.amount,
          proofKey: `demo/payments/${workflow.code.toLowerCase()}-stage-${i + 1}-proof.txt`,
          referenceNumber: `DEMO-${workflow.code}-PAY-${i + 1}`,
          receiptKey: `demo/receipts/${workflow.code.toLowerCase()}-stage-${i + 1}-receipt.txt`,
          receiptNumber: `DEMO-RCPT-${workflow.code}-${i + 1}`,
          actorId: cashier._id,
          capturedAt: paidAt,
        }],
        createdAt: paidAt,
        updatedAt: paidAt,
      });
    }
  }

  if (workflow.appointmentType === AppointmentType.OCULAR) {
    await CashCollection.create({
      appointmentId: appointment._id,
      salesStaffId: sales._id,
      customerId: customer._id,
      amountCollected: 1500,
      notes: 'DEMO: Ocular fee cash collection from sales staff.',
      photoKey: `demo/cash/${workflow.code.toLowerCase()}-ocular-fee.txt`,
      status: CashCollectionStatus.RECEIVED,
      receivedBy: cashier._id,
      amountReceived: 1500,
      receivedAt: dateAt(workflow.appointmentDate, 16),
      createdAt: dateAt(workflow.appointmentDate, 15),
      updatedAt: dateAt(workflow.appointmentDate, 16),
    });
  }

  if (workflow.fabricationDates?.length) {
    const statuses = [FabricationStatus.MATERIAL_PREP, FabricationStatus.WELDING, workflow.status === ProjectStatus.COMPLETED ? FabricationStatus.DONE : FabricationStatus.FINISHING];
    await FabricationItem.insertMany([
      {
        projectId: project._id,
        projectItemId: item._id,
        title: `${workflow.title} frame`,
        description: 'Main structure fabrication.',
        quantity: 1,
        isCompleted: workflow.status === ProjectStatus.COMPLETED,
        completedAt: workflow.completedAt ? dateAt(workflow.completedAt, 14) : undefined,
        workerNotes: `DEMO: Fabrication item for ${workflow.title}.`,
        photoKeys: [`demo/fabrication/${workflow.code.toLowerCase()}-frame.txt`],
        createdAt: dateAt(workflow.fabricationDates[0]!, 9),
        updatedAt: workflow.completedAt ? dateAt(workflow.completedAt, 14) : dateAt(workflow.fabricationDates.at(-1)!, 15),
      },
      {
        projectId: project._id,
        projectItemId: item._id,
        title: `${workflow.title} finishing`,
        description: 'Polishing, QA, and installation preparation.',
        quantity: 1,
        isCompleted: workflow.status === ProjectStatus.COMPLETED,
        completedAt: workflow.completedAt ? dateAt(workflow.completedAt, 15) : undefined,
        workerNotes: `DEMO: Finishing item for ${workflow.title}.`,
        photoKeys: [`demo/fabrication/${workflow.code.toLowerCase()}-finish.txt`],
        createdAt: dateAt(workflow.fabricationDates[0]!, 9),
        updatedAt: workflow.completedAt ? dateAt(workflow.completedAt, 15) : dateAt(workflow.fabricationDates.at(-1)!, 15),
      },
    ]);

    for (let i = 0; i < workflow.fabricationDates.length; i += 1) {
      await FabricationUpdate.create({
        projectId: project._id,
        projectItemId: item._id,
        status: statuses[i] || FabricationStatus.ASSEMBLY,
        notes: `DEMO: ${workflow.title} fabrication update ${i + 1}.`,
        photoKeys: [`demo/fabrication/${workflow.code.toLowerCase()}-update-${i + 1}.txt`],
        updatedBy: fabricator._id,
        createdAt: dateAt(workflow.fabricationDates[i]!, 15),
      });
    }
  }

  const uploadKeys = [
    `demo/visit-reports/${workflow.code.toLowerCase()}-site-photo.txt`,
    `demo/visit-reports/${workflow.code.toLowerCase()}-sketch.txt`,
    `demo/visit-reports/${workflow.code.toLowerCase()}-reference.txt`,
    `demo/designs/${workflow.code.toLowerCase()}-initial-design.txt`,
    `demo/projects/${workflow.code.toLowerCase()}-site-photo.txt`,
    `demo/contracts/${workflow.code.toLowerCase()}-signed-contract.txt`,
    `demo/blueprints/${workflow.code.toLowerCase()}-blueprint.txt`,
    `demo/blueprints/${workflow.code.toLowerCase()}-design.txt`,
    `demo/blueprints/${workflow.code.toLowerCase()}-costing.txt`,
    `demo/cash/${workflow.code.toLowerCase()}-ocular-fee.txt`,
    `demo/fabrication/${workflow.code.toLowerCase()}-frame.txt`,
    `demo/fabrication/${workflow.code.toLowerCase()}-finish.txt`,
    `demo/fabrication/${workflow.code.toLowerCase()}-update-1.txt`,
    `demo/fabrication/${workflow.code.toLowerCase()}-update-2.txt`,
    `demo/fabrication/${workflow.code.toLowerCase()}-update-3.txt`,
    `demo/receipts/${workflow.code.toLowerCase()}-stage-1-receipt.txt`,
    `demo/receipts/${workflow.code.toLowerCase()}-stage-2-receipt.txt`,
    `demo/receipts/${workflow.code.toLowerCase()}-stage-3-receipt.txt`,
    `demo/payments/${workflow.code.toLowerCase()}-stage-1-proof.txt`,
    `demo/payments/${workflow.code.toLowerCase()}-stage-2-proof.txt`,
    `demo/payments/${workflow.code.toLowerCase()}-stage-3-proof.txt`,
  ];
  uploadKeys.forEach((key) => uploads.add(key));

  await Notification.insertMany([
    {
      userId: customer._id,
      category: NotificationCategory.APPOINTMENT,
      title: 'Appointment Completed',
      message: `${workflow.title} consultation was completed.`,
      link: '/appointments',
      isRead: true,
      createdAt: dateAt(workflow.appointmentDate, 12),
    },
    {
      userId: customer._id,
      category: NotificationCategory.BLUEPRINT,
      title: 'Quotation Sent',
      message: `${workflow.title} quotation and blueprint are available.`,
      link: '/projects',
      isRead: workflow.status === ProjectStatus.COMPLETED,
      createdAt: workflow.blueprintAt ? dateAt(workflow.blueprintAt, 15) : dateAt(workflow.appointmentDate, 15),
    },
    {
      userId: cashier._id,
      category: NotificationCategory.PAYMENT,
      title: 'Payment Workflow Updated',
      message: `${projectNumber} payment records were updated.`,
      link: '/cashier-queue',
      isRead: false,
      createdAt: workflow.paymentAt ? dateAt(workflow.paymentAt, 16) : dateAt(workflow.appointmentDate, 16),
    },
    {
      userId: fabricator._id,
      category: NotificationCategory.FABRICATION,
      title: 'Fabrication Assignment',
      message: `${workflow.title} is assigned for fabrication tracking.`,
      link: '/fabrication',
      isRead: workflow.status === ProjectStatus.COMPLETED,
      createdAt: workflow.fabricationDates?.[0] ? dateAt(workflow.fabricationDates[0], 9) : dateAt(workflow.appointmentDate, 16),
    },
  ]);

  await AuditLog.insertMany([
    {
      action: AuditAction.APPOINTMENT_CREATED,
      actorId: customer._id,
      actorEmail: customer.email,
      targetType: 'appointment',
      targetId: appointment._id,
      details: { demo: true, projectNumber, stage: 'booking' },
      createdAt: dateAt(workflow.bookedAt, 9),
    },
    {
      action: AuditAction.APPOINTMENT_CONFIRMED,
      actorId: agent._id,
      actorEmail: agent.email,
      targetType: 'appointment',
      targetId: appointment._id,
      details: { demo: true, projectNumber, stage: 'confirmation' },
      createdAt: dateAt(workflow.confirmedAt, 10),
    },
    {
      action: AuditAction.PROJECT_CREATED,
      actorId: sales._id,
      actorEmail: sales.email,
      targetType: 'project',
      targetId: project._id,
      details: { demo: true, projectNumber, stage: 'project_created' },
      createdAt: dateAt(workflow.reportAt || workflow.appointmentDate, 13),
    },
    {
      action: AuditAction.BLUEPRINT_APPROVED,
      actorId: admin._id,
      actorEmail: admin.email,
      targetType: 'project',
      targetId: project._id,
      details: { demo: true, projectNumber, stage: 'blueprint_quotation' },
      createdAt: workflow.blueprintAt ? dateAt(workflow.blueprintAt, 14) : dateAt(workflow.appointmentDate, 14),
    },
    {
      action: workflow.status === ProjectStatus.COMPLETED ? AuditAction.PROJECT_COMPLETED : AuditAction.PROJECT_UPDATED,
      actorId: workflow.status === ProjectStatus.COMPLETED ? fabricator._id : engineer._id,
      actorEmail: workflow.status === ProjectStatus.COMPLETED ? fabricator.email : engineer.email,
      targetType: 'project',
      targetId: project._id,
      details: { demo: true, projectNumber, stage: workflow.status },
      createdAt: workflow.completedAt ? dateAt(workflow.completedAt, 16) : dateAt('2026-03-20', 16),
    },
  ]);

  return { appointment, project, item, report };
}

async function seedEdgeAppointments(users: Awaited<ReturnType<typeof seedUsers>>) {
  const agent = users.get(email('agent'))!;
  const sales = users.get(email('sales'))!;

  for (const edge of edgeAppointments) {
    const customer = users.get(email(edge.customerKey))!;
    await Appointment.create({
      customerId: customer._id,
      type: AppointmentType.OFFICE,
      date: edge.date,
      slotCode: edge.slotCode,
      status: edge.status,
      attendanceStatus: edge.attendanceStatus,
      attendanceNotes: edge.notes,
      attendanceUpdatedBy: sales._id,
      attendanceUpdatedAt: dateAt(edge.date, 11),
      salesStaffId: sales._id,
      serviceTypes: [ServiceType.CUSTOM],
      customerNotes: edge.notes,
      bookedBy: customer._id,
      confirmedBy: agent._id,
      consultationStartedAt: edge.attendanceStatus === AppointmentAttendanceStatus.CUSTOMER_DECLINED ? dateAt(edge.date, 10, 5) : undefined,
      consultationCompletedAt: edge.attendanceStatus === AppointmentAttendanceStatus.CUSTOMER_DECLINED ? dateAt(edge.date, 10, 35) : undefined,
      cancellationReason: edge.status === AppointmentStatus.CANCELLED ? 'Customer voluntarily chose not to proceed during consultation.' : undefined,
      cancelledBy: edge.status === AppointmentStatus.CANCELLED ? customer._id : undefined,
      createdAt: dateAt(edge.date, 8),
      updatedAt: dateAt(edge.date, 11),
    });
  }
}

async function main() {
  await mongoose.connect(mongoUri);

  await clearExistingDemoData();

  const client = r2Client();
  const uploadKeys = new Set<string>(['demo/signatures/cashier-nina.txt']);
  const users = await seedUsers();

  for (const workflow of workflows) {
    await seedWorkflow(workflow, users, uploadKeys);
  }
  await seedEdgeAppointments(users);

  for (const key of uploadKeys) {
    await uploadDemoObject(client, key, `Demo placeholder object for ${key}`);
  }

  const counts = {
    users: await User.countDocuments({ email: /@demo\.rmv\.local$/i }),
    appointments: await Appointment.countDocuments({ customerNotes: /^DEMO:/ }),
    visitReports: await VisitReport.countDocuments({ notes: /^DEMO:/ }),
    projects: await Project.countDocuments({ projectNumber: /^DEMO-2026-/ }),
    projectItems: await ProjectItem.countDocuments({ notes: /^DEMO:/ }),
    blueprints: await Blueprint.countDocuments({ blueprintKey: /^demo\// }),
    paymentPlans: await PaymentPlan.countDocuments({}),
    payments: await Payment.countDocuments({ referenceNumber: /^DEMO-/ }),
    fabricationItems: await FabricationItem.countDocuments({ workerNotes: /^DEMO:/ }),
    fabricationUpdates: await FabricationUpdate.countDocuments({ notes: /^DEMO:/ }),
    cashCollections: await CashCollection.countDocuments({ notes: /^DEMO:/ }),
    notifications: await Notification.countDocuments({ userId: { $in: [...users.values()].map((u) => u._id) } }),
    auditLogs: await AuditLog.countDocuments({ 'details.demo': true }),
  };

  console.log('Seeded complete demo workflow data for January-March 2026:');
  console.log(counts);
  console.log(`R2 objects ${client ? 'uploaded' : 'skipped because R2 is not configured'}: ${client ? uploadKeys.size : 0}`);
  console.log('Demo login password for seeded accounts: Demo@12345');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Failed to seed demo workflow data:', err);
  await mongoose.disconnect();
  process.exit(1);
});
