import {
  VisitReport, Appointment, Project, User, AuditLog,
} from '../../models/index.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, ProjectStatus, Role, AuditAction, NotificationCategory,
  ServiceType,
} from '../../utils/constants.js';
import { visitReportStateMachine, appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import type { CreateVisitReportInput, UpdateVisitReportInput, ReturnVisitReportInput } from './visit-reports.validation.js';
import type { Types } from 'mongoose';

import type { ICustomerSiteDetails } from '../../models/Appointment.js';

// ── Auto-create Draft (called when Agent confirms appointment) ──
// Creates a single initial report. Sales staff can add more via createReport().
// If customerSiteDetails is provided (customer filled in pre-visit info), pre-populate the report.

export async function autoCreateDraft(
  appointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  visitType: string,
  customerSiteDetails?: ICustomerSiteDetails,
): Promise<void> {
  // Check if any report already exists for this appointment
  const existing = await VisitReport.findOne({ appointmentId });
  if (existing) return; // idempotent

  // Build report data, pre-populating from customer site details if available
  const reportData: Record<string, any> = {
    appointmentId,
    customerId,
    salesStaffId,
    status: VisitReportStatus.DRAFT,
    visitType,
    serviceType: customerSiteDetails?.serviceType || ServiceType.CUSTOM,
    serviceTypeCustom: customerSiteDetails?.serviceTypeCustom,
    measurementUnit: customerSiteDetails?.measurementUnit,
    lineItems: customerSiteDetails?.lineItems || [],
    siteConditions: customerSiteDetails?.siteConditions,
    materials: customerSiteDetails?.materials,
    finishes: customerSiteDetails?.finishes,
    preferredDesign: customerSiteDetails?.preferredDesign,
    customerRequirements: customerSiteDetails?.customerRequirements,
    notes: customerSiteDetails?.notes,
    photoKeys: customerSiteDetails?.photoKeys || [],
    videoKeys: customerSiteDetails?.videoKeys || [],
    sketchKeys: customerSiteDetails?.sketchKeys || [],
    referenceImageKeys: customerSiteDetails?.referenceImageKeys || [],
  };

  const report = await VisitReport.create(reportData);

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_CREATED,
    actorId: salesStaffId.toString(),
    targetType: 'visit_report',
    targetId: report._id,
    details: { appointmentId: appointmentId.toString(), autoCreated: true },
  });
}

// ── Create Report (Sales Staff adds another project/report to an appointment) ──

export async function createReport(
  input: CreateVisitReportInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  // Verify the appointment exists and belongs to this sales staff
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.salesStaffId?.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this appointment');
  }

  // Appointment must be confirmed or completed to add reports
  if (![AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED].includes(appointment.status as AppointmentStatus)) {
    throw AppError.badRequest('Appointment must be confirmed to add visit reports');
  }

  const report = await VisitReport.create({
    appointmentId: input.appointmentId,
    customerId: appointment.customerId,
    salesStaffId,
    status: VisitReportStatus.DRAFT,
    visitType: input.visitType || 'ocular',
    serviceType: input.serviceType,
    serviceTypeCustom: input.serviceTypeCustom,
    lineItems: [],
    photoKeys: [],
    videoKeys: [],
    sketchKeys: [],
    referenceImageKeys: [],
  });

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_CREATED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { appointmentId: input.appointmentId, serviceType: input.serviceType },
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

// ── Get by ID ──

export async function getVisitReport(reportId: string) {
  const report = await VisitReport.findById(reportId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'date slotCode type customerAddress');
  if (!report) throw AppError.notFound('Visit report not found');
  return report;
}

// ── Get by Appointment (returns ARRAY — multiple reports per appointment) ──

export async function getByAppointment(appointmentId: string) {
  const reports = await VisitReport.find({ appointmentId })
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'date slotCode type customerAddress')
    .sort({ createdAt: 1 });
  return reports;
}

// ── List for Sales Staff ──

export async function listForSalesStaff(salesStaffId: string, query: {
  status?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = { salesStaffId };
  if (query.status) filter.status = query.status;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── List Submitted (Engineer queue) ──

export async function listSubmitted(query: {
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter = { status: VisitReportStatus.SUBMITTED };

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── List All (Admin view) ──

export async function listAll(query: {
  status?: string;
  salesStaffId?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.salesStaffId) filter.salesStaffId = query.salesStaffId;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── Update Report (Sales Staff fills draft/returned) ──

export async function updateReport(
  reportId: string,
  input: UpdateVisitReportInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  // Only the assigned sales staff can edit
  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  // Can only edit in DRAFT or RETURNED status
  if (![VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)) {
    throw AppError.badRequest('Visit report can only be edited in draft or returned status');
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (report as any)[key] = value;
      changes[key] = value;
    }
  }

  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_UPDATED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: changes,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

// ── Submit Report (Sales Staff → Engineer) ──

export async function submitReport(
  reportId: string,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.SUBMITTED);

  report.status = VisitReportStatus.SUBMITTED;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_SUBMITTED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    ipAddress: ip,
    userAgent: ua,
  });

  // ── Auto-complete appointment only when ALL reports for this appointment are submitted ──
  const appointment = await Appointment.findById(report.appointmentId);
  if (appointment && appointment.status === AppointmentStatus.CONFIRMED) {
    const pendingCount = await VisitReport.countDocuments({
      appointmentId: report.appointmentId,
      status: { $in: [VisitReportStatus.DRAFT, VisitReportStatus.RETURNED] },
    });

    if (pendingCount === 0) {
      appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
      appointment.status = AppointmentStatus.COMPLETED;
      await appointment.save();

      await AuditLog.create({
        action: AuditAction.APPOINTMENT_COMPLETED,
        actorId: salesStaffId,
        targetType: 'appointment',
        targetId: appointment._id,
        details: { triggeredBy: 'system', reason: 'all_visit_reports_submitted' },
        ipAddress: ip,
        userAgent: ua,
      });
    }
  }

  // ── Auto-create Project (idempotent — use visitReportId) ──
  if (appointment) {
    const existingProject = await Project.findOne({ visitReportId: report._id });
    if (!existingProject) {
      const serviceLabel = report.serviceTypeCustom || report.serviceType || 'General Fabrication';
      const project = await Project.create({
        appointmentId: report.appointmentId,
        visitReportId: report._id,
        customerId: report.customerId,
        salesStaffId: report.salesStaffId,
        title: `${serviceLabel} - ${appointment.customerNotes || 'Visit Report'}`,
        serviceType: serviceLabel,
        description: report.customerRequirements || report.notes || 'Created from visit report',
        siteAddress: appointment.customerAddress || 'TBD',
        measurements: report.measurements,
        materialType: report.materials,
        finishColor: report.finishes,
        quantity: 1,
        notes: report.notes,
        status: ProjectStatus.SUBMITTED,
        mediaKeys: [...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys],
      });

      await AuditLog.create({
        action: AuditAction.PROJECT_CREATED,
        actorId: salesStaffId,
        targetType: 'project',
        targetId: project._id,
        details: { triggeredBy: 'system', reason: 'visit_report_submitted', visitReportId: reportId },
        ipAddress: ip,
        userAgent: ua,
      });

      // Notify admins about new project
      await notifyRole(
        Role.ADMIN,
        NotificationCategory.PROJECT,
        'New Project from Visit Report',
        `A new project "${project.title}" has been created from a visit report. Assign an engineer.`,
        `/projects/${project._id}`,
      );

      // Notify customer
      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Project Created',
        `Your project "${project.title}" has been created from the visit report. An engineer will be assigned shortly.`,
        `/projects/${project._id}`,
      );
    }
  }

  // Notify engineers about submitted report
  await notifyRole(
    Role.ENGINEER,
    NotificationCategory.PROJECT,
    'New Visit Report Submitted',
    `A sales visit report has been submitted and is ready for review.`,
    `/visit-reports/${report._id}`,
  );

  return report;
}

// ── Delete Report (Sales Staff removes accidental extra project) ──

export async function deleteReport(
  reportId: string,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  if (![VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)) {
    throw AppError.badRequest('Only draft or returned reports can be deleted');
  }

  const hasLinkedProject = await Project.exists({ visitReportId: report._id });
  if (hasLinkedProject) {
    throw AppError.badRequest('Cannot delete a report that already has a linked project');
  }

  const reportCountForAppointment = await VisitReport.countDocuments({
    appointmentId: report.appointmentId,
  });

  if (reportCountForAppointment <= 1) {
    throw AppError.badRequest('At least one visit report must remain for this appointment');
  }

  const deletedId = report._id.toString();
  await report.deleteOne();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_DELETED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: {
      appointmentId: report.appointmentId.toString(),
      status: report.status,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deletedId };
}

// ── Return Report (Engineer → Sales Staff) ──

export async function returnReport(
  reportId: string,
  input: ReturnVisitReportInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.RETURNED);

  report.status = VisitReportStatus.RETURNED;
  report.returnReason = input.reason;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_RETURNED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify the sales staff
  await createAndSendNotification(
    report.salesStaffId,
    NotificationCategory.PROJECT,
    'Visit Report Returned',
    `Your visit report has been returned for revision. Reason: ${input.reason}`,
    `/visit-reports/${report._id}`,
  );

  return report;
}

// ── Mark as Completed (when engineer finishes blueprint from this report) ──

export async function markCompleted(
  reportId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.COMPLETED);

  report.status = VisitReportStatus.COMPLETED;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_COMPLETED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}
