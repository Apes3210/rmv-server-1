import {
  Project, Payment, PaymentPlan, Appointment,
  FabricationUpdate, User, CashCollection, AuditLog, VisitReport, Blueprint,
} from '../../models/index.js';
import {
  ProjectStatus, PaymentStageStatus, FabricationStatus,
  AppointmentStatus, AppointmentType, Role,
} from '../../utils/constants.js';
import type { Types } from 'mongoose';

// ── Recent Audit Logs (Admin) ──

export async function getRecentAuditLogs(query: {
  limit?: number;
  page?: number;
}) {
  const limit = Math.min(query.limit ?? 5, 50);
  const page = Math.max(query.page ?? 1, 1);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AuditLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('actorId', 'firstName lastName email')
      .lean()
      .exec(),
    AuditLog.countDocuments().exec(),
  ]);

  return {
    items,
    total,
    page,
    limit,
    hasMore: skip + items.length < total,
  };
}

// ── Revenue Report (Admin + Cashier) ──

export async function getRevenueReport(query: {
  dateFrom?: string;
  dateTo?: string;
  groupBy?: string; // 'day' | 'week' | 'month'
}) {
  const filter: Record<string, unknown> = {
    status: PaymentStageStatus.VERIFIED,
  };

  if (query.dateFrom || query.dateTo) {
    filter.verifiedAt = {};
    if (query.dateFrom) (filter.verifiedAt as Record<string, unknown>).$gte = new Date(query.dateFrom);
    if (query.dateTo) (filter.verifiedAt as Record<string, unknown>).$lte = new Date(query.dateTo + 'T23:59:59.999Z');
  }

  const payments = await Payment.find(filter).sort({ verifiedAt: 1 });

  const totalRevenue = payments.reduce((sum, p) => sum + p.amountPaid, 0);
  const totalPayments = payments.length;

  // Group by period
  const groupBy = query.groupBy || 'month';
  const grouped: Record<string, { revenue: number; count: number }> = {};

  for (const payment of payments) {
    let key: string;
    const date = payment.verifiedAt!;

    if (groupBy === 'day') {
      key = date.toISOString().split('T')[0];
    } else if (groupBy === 'week') {
      const d = new Date(date);
      const dayOfWeek = d.getDay();
      d.setDate(d.getDate() - dayOfWeek);
      key = `Week of ${d.toISOString().split('T')[0]}`;
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!grouped[key]) grouped[key] = { revenue: 0, count: 0 };
    grouped[key].revenue += payment.amountPaid;
    grouped[key].count += 1;
  }

  // By payment method
  const byMethod: Record<string, number> = {};
  for (const payment of payments) {
    if (!byMethod[payment.method]) byMethod[payment.method] = 0;
    byMethod[payment.method] += payment.amountPaid;
  }

  return {
    totalRevenue,
    totalPayments,
    byPeriod: Object.entries(grouped).map(([period, data]) => ({
      period,
      ...data,
    })),
    byPaymentMethod: Object.entries(byMethod).map(([method, amount]) => ({
      method,
      amount,
    })),
  };
}

// ── Payment Stage Breakdown ──

export async function getPaymentStageReport(query: {
  dateFrom?: string;
  dateTo?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) (filter.createdAt as Record<string, unknown>).$gte = new Date(query.dateFrom);
    if (query.dateTo) (filter.createdAt as Record<string, unknown>).$lte = new Date(query.dateTo + 'T23:59:59.999Z');
  }

  const plans = await PaymentPlan.find(filter);

  const statusCounts: Record<string, number> = {};
  let totalAmount = 0;
  let totalPaid = 0;

  for (const plan of plans) {
    for (const stage of plan.stages) {
      if (!statusCounts[stage.status]) statusCounts[stage.status] = 0;
      statusCounts[stage.status] += 1;
      totalAmount += stage.amount;
      totalPaid += stage.amountPaid;
    }
  }

  return {
    totalPlans: plans.length,
    totalAmount,
    totalPaid,
    totalOutstanding: totalAmount - totalPaid,
    byStatus: Object.entries(statusCounts).map(([status, count]) => ({
      status,
      count,
    })),
  };
}

// ── Outstanding Payments ──

export async function getOutstandingReport() {
  const plans = await PaymentPlan.find()
    .populate('projectId', 'title customerId salesStaffId');

  const outstanding = plans
    .filter(plan => plan.stages.some(s => s.remainingBalance > 0))
    .map(plan => ({
      projectId: plan.projectId,
      totalAmount: plan.totalAmount,
      totalPaid: plan.stages.reduce((sum, s) => sum + s.amountPaid, 0),
      totalOutstanding: plan.stages.reduce((sum, s) => sum + s.remainingBalance, 0),
      stages: plan.stages.map(s => ({
        label: s.label,
        amount: s.amount,
        paid: s.amountPaid,
        remaining: s.remainingBalance,
        status: s.status,
      })),
    }));

  return {
    totalOutstanding: outstanding.reduce((sum, o) => sum + o.totalOutstanding, 0),
    projects: outstanding,
  };
}

// ── Project Pipeline (active projects by status) ──

export async function getProjectPipelineReport() {
  const pipeline = await Project.aggregate([
    { $match: { deletedAt: null, status: { $ne: ProjectStatus.CANCELLED } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const total = pipeline.reduce((sum, p) => sum + p.count, 0);

  return {
    total,
    byStatus: pipeline.map(p => ({
      status: p._id,
      count: p.count,
      percentage: total > 0 ? Math.round((p.count / total) * 100) : 0,
    })),
  };
}

// ── Staff Workload Report ──

export async function getWorkloadReport() {
  // Active projects per engineer
  const engineerWorkload = await Project.aggregate([
    { $match: { deletedAt: null, status: { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] } } },
    { $unwind: '$engineerIds' },
    {
      $group: {
        _id: '$engineerIds',
        activeProjects: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'engineer',
      },
    },
    { $unwind: '$engineer' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$engineer.firstName', ' ', '$engineer.lastName'] },
        activeProjects: 1,
      },
    },
    { $sort: { activeProjects: -1 } },
  ]);

  // Active projects per fabrication lead
  const fabWorkload = await Project.aggregate([
    {
      $match: {
        deletedAt: null,
        status: ProjectStatus.FABRICATION,
        fabricationLeadId: { $exists: true },
      },
    },
    {
      $group: {
        _id: '$fabricationLeadId',
        activeProjects: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'staff',
      },
    },
    { $unwind: '$staff' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$staff.firstName', ' ', '$staff.lastName'] },
        activeProjects: 1,
      },
    },
    { $sort: { activeProjects: -1 } },
  ]);

  // Appointments per sales staff (this month)
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const nextMonth = now.getMonth() === 11
    ? `${now.getFullYear() + 1}-01-01`
    : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, '0')}-01`;

  const salesWorkload = await Appointment.aggregate([
    {
      $match: {
        date: { $gte: monthStart, $lt: nextMonth },
        status: { $ne: AppointmentStatus.CANCELLED },
        salesStaffId: { $exists: true },
      },
    },
    {
      $group: {
        _id: '$salesStaffId',
        appointments: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'staff',
      },
    },
    { $unwind: '$staff' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$staff.firstName', ' ', '$staff.lastName'] },
        appointments: 1,
      },
    },
    { $sort: { appointments: -1 } },
  ]);

  return {
    engineers: engineerWorkload,
    fabrication: fabWorkload,
    sales: salesWorkload,
  };
}

// ── Appointment Conversion Report ──

export async function getConversionReport(query: {
  dateFrom?: string;
  dateTo?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (query.dateFrom) filter.date = { ...(filter.date as object || {}), $gte: query.dateFrom };
  if (query.dateTo) filter.date = { ...(filter.date as object || {}), $lte: query.dateTo };

  const appointments = await Appointment.find(filter);

  const totalAppointments = appointments.length;
  const completed = appointments.filter(a => a.status === AppointmentStatus.COMPLETED).length;
  const cancelled = appointments.filter(a => a.status === AppointmentStatus.CANCELLED).length;
  const noShow = appointments.filter(a => a.status === AppointmentStatus.NO_SHOW).length;

  // Count how many completed appointments resulted in projects
  const completedIds = appointments
    .filter(a => a.status === AppointmentStatus.COMPLETED)
    .map(a => a._id);

  const projectsCreated = await Project.countDocuments({
    appointmentId: { $in: completedIds },
  });

  const byType = {
    office: appointments.filter(a => a.type === AppointmentType.OFFICE).length,
    ocular: appointments.filter(a => a.type === AppointmentType.OCULAR).length,
  };

  return {
    totalAppointments,
    completed,
    cancelled,
    noShow,
    projectsCreated,
    conversionRate: completed > 0
      ? Math.round((projectsCreated / completed) * 100)
      : 0,
    completionRate: totalAppointments > 0
      ? Math.round((completed / totalAppointments) * 100)
      : 0,
    byType,
  };
}

// ── Dashboard Summary ──

export async function getDashboardSummary(userId?: string, userRoles?: string[]) {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Determine if the caller is a pure customer (no staff/admin roles)
    const isCustomerOnly = userRoles?.includes(Role.CUSTOMER)
      && !userRoles?.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.ENGINEER, Role.CASHIER].includes(r as Role));

    // Appointment filter: scope to the customer's own appointments when applicable
    const appointmentBaseFilter = isCustomerOnly && userId ? { customerId: userId } : {};

    // Project filter for customer-scoped counts
    const customerProjectFilter = isCustomerOnly && userId ? { customerId: userId } : {};

    // For customer-scoped pending payments, we need to find the customer's project IDs first
    const customerProjectIds = isCustomerOnly && userId
      ? (await Project.find({ customerId: userId, deletedAt: null }).distinct('_id').exec())
      : null;

    const [
      totalProjects,
      activeProjects,
      completedProjects,
      pendingPayments,
      revenueResult,
      pendingAppointments,
      totalAppointmentsToday,
      fabricationInProgress,
      pendingVisitReports,
      pendingCashPayments,
      totalUsers,
      pendingBlueprints,
    ] = await Promise.all([
      Project.countDocuments({ deletedAt: null, ...customerProjectFilter }).exec(),
      Project.countDocuments({
        deletedAt: null,
        status: { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] },
        ...(userRoles?.includes(Role.ENGINEER) && !userRoles?.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r as Role))
          ? { $or: [{ engineerIds: userId }, { status: ProjectStatus.SUBMITTED, engineerIds: { $size: 0 } }] }
          : userRoles?.includes(Role.FABRICATION_STAFF) && !userRoles?.some(r => [Role.ADMIN, Role.ENGINEER].includes(r as Role))
            ? { status: ProjectStatus.FABRICATION }
            : userRoles?.includes(Role.SALES_STAFF) && !userRoles?.includes(Role.ADMIN)
              ? { salesStaffId: userId }
              : userRoles?.includes(Role.CUSTOMER) && !userRoles?.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r as Role))
                ? { customerId: userId }
                : {}),
      }).exec(),
      Project.countDocuments({ deletedAt: null, status: ProjectStatus.COMPLETED, ...customerProjectFilter }).exec(),
      // For customers, only count payments linked to their projects
      customerProjectIds
        ? Payment.countDocuments({ status: PaymentStageStatus.PROOF_SUBMITTED, projectId: { $in: customerProjectIds } }).exec()
        : Payment.countDocuments({ status: PaymentStageStatus.PROOF_SUBMITTED }).exec(),
      Payment.aggregate([
        { $match: { status: PaymentStageStatus.VERIFIED, verifiedAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
      ]).exec(),
      Appointment.countDocuments({
        ...appointmentBaseFilter,
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.RESCHEDULE_REQUESTED] },
      }).exec(),
      Appointment.countDocuments({
        ...appointmentBaseFilter,
        date: todayStr,
        status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.REQUESTED] },
      }).exec(),
      Project.countDocuments({
        deletedAt: null,
        status: ProjectStatus.FABRICATION,
        ...(isCustomerOnly && userId ? { customerId: userId } : {}),
      }).exec(),
      // Count draft/returned visit reports for the current user (sales staff KPI)
      userId
        ? VisitReport.countDocuments({
            salesStaffId: userId,
            status: { $in: ['draft', 'returned'] },
          }).exec()
        : Promise.resolve(0),
      // Count appointments with pending cash payment (scoped to sales staff)
      Appointment.countDocuments({
        ocularFeeStatus: 'cash_pending',
        ...(userRoles?.includes(Role.SALES_STAFF) && !userRoles?.includes(Role.ADMIN) && userId
          ? { salesStaffId: userId }
          : {}),
      }).exec(),
      // Admin-only: total active users
      User.countDocuments({ isActive: true }).exec(),
      // Admin-only: blueprints pending customer review
      Blueprint.countDocuments({ status: { $in: ['uploaded', 'revision_uploaded'] } }).exec(),
    ]);

    const revenueThisMonth = revenueResult?.[0]?.total ?? 0;

    // Conversion rate: completed / total (avoid div by zero)
    const conversionRate = totalProjects > 0 ? completedProjects / totalProjects : 0;

    // ── Pending installation confirmations (customer-facing) ──
    // Find projects at ready_for_delivery that the customer hasn't confirmed yet
    let pendingInstallationConfirmations: { _id: string; title: string }[] = [];
    if (isCustomerOnly && userId) {
      const readyProjects = await FabricationUpdate.aggregate([
        { $sort: { createdAt: -1 as const } },
        { $group: { _id: '$projectId', latestStatus: { $first: '$status' } } },
        { $match: { latestStatus: FabricationStatus.READY_FOR_DELIVERY } },
      ]).exec();
      const readyProjectIds = readyProjects.map(r => r._id);
      if (readyProjectIds.length > 0) {
        pendingInstallationConfirmations = await Project.find({
          _id: { $in: readyProjectIds },
          customerId: userId,
          installationConfirmedAt: null,
          deletedAt: null,
        }).select('_id title').lean().exec() as unknown as { _id: string; title: string }[];
      }
    }

    return {
      totalProjects,
      activeProjects,
      completedProjects,
      pendingPayments,
      revenueThisMonth,
      totalRevenue: revenueThisMonth,
      pendingAppointments,
      totalAppointmentsToday,
      todayAppointments: totalAppointmentsToday,
      fabricationInProgress,
      conversionRate,
      pendingVisitReports,
      pendingCashPayments,
      totalUsers,
      pendingBlueprints,
      pendingInstallationConfirmations,
    };
  } catch (error) {
    console.error('getDashboardSummary error:', error);
    // Return safe defaults so the dashboard doesn't crash
    return {
      totalProjects: 0,
      activeProjects: 0,
      completedProjects: 0,
      pendingPayments: 0,
      revenueThisMonth: 0,
      totalRevenue: 0,
      pendingAppointments: 0,
      totalAppointmentsToday: 0,
      todayAppointments: 0,
      fabricationInProgress: 0,
      conversionRate: 0,
      pendingVisitReports: 0,
      pendingCashPayments: 0,
      totalUsers: 0,
      pendingBlueprints: 0,
      pendingInstallationConfirmations: [],
    };
  }
}
