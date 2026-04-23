import {
  VisitReport, Appointment, Project, User, AuditLog,
} from '../../models/index.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, ProjectStatus, Role, AuditAction, NotificationCategory,
  ServiceType, OcularFeePaymentChoice,
} from '../../utils/constants.js';
import { visitReportStateMachine, appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import type { CreateVisitReportInput, UpdateVisitReportInput, ReturnVisitReportInput, ReopenVisitReportInput } from './visit-reports.validation.js';
import type { Types } from 'mongoose';

import type { ICustomerSiteDetails } from '../../models/Appointment.js';

function isNonEmptyString(value?: string | null) {
  return Boolean(value?.trim());
}

function hasAnyMeasuredDimensions(report: {
  lineItems?: Array<{
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
  }>;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    raw?: string;
  };
}) {
  const hasLineItemMeasurements = Boolean(
    report.lineItems?.some((item) =>
      item.length != null ||
      item.width != null ||
      item.height != null ||
      item.area != null ||
      item.thickness != null,
    ),
  );

  const legacy = report.measurements;
  const hasLegacyMeasurements = Boolean(
    legacy && (
      legacy.length != null ||
      legacy.width != null ||
      legacy.height != null ||
      legacy.area != null ||
      legacy.thickness != null ||
      legacy.raw?.trim()
    ),
  );

  return hasLineItemMeasurements || hasLegacyMeasurements;
}

function getIncompleteOcularFields(report: {
  actualVisitDateTime?: Date | string | null;
  lineItems?: Array<{
    label?: string;
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    quantity?: number;
    notes?: string;
  }>;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    raw?: string;
  };
  siteConditions?: {
    environment?: string;
    floorType?: string;
    wallMaterial?: string;
    hasElectrical?: boolean;
    hasPlumbing?: boolean;
    accessNotes?: string;
    obstaclesOrConstraints?: string;
  };
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  photoKeys?: string[];
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
}) {
  const missing: string[] = [];

  if (!report.actualVisitDateTime) {
    missing.push('actual visit date and time');
  }

  const lineItems = report.lineItems || [];
  if (lineItems.length > 0) {
    lineItems.forEach((item, index) => {
      const isComplete = isNonEmptyString(item.label)
        && item.quantity != null
        && item.quantity >= 1
        && item.length != null
        && item.width != null
        && item.height != null
        && item.thickness != null
        && item.area != null
        && isNonEmptyString(item.notes);

      if (!isComplete) {
        missing.push(`complete measurement details for line item ${index + 1}`);
      }
    });
  } else {
    const legacy = report.measurements;
    const hasCompleteLegacyMeasurements = Boolean(
      legacy
      && legacy.length != null
      && legacy.width != null
      && legacy.height != null
      && legacy.thickness != null
      && legacy.area != null
      && isNonEmptyString(legacy.raw),
    );

    if (!hasCompleteLegacyMeasurements) {
      missing.push('at least one complete measurement item');
    }
  }

  if (!isNonEmptyString(report.siteConditions?.environment)) missing.push('site environment');
  if (!isNonEmptyString(report.siteConditions?.floorType)) missing.push('floor type');
  if (!isNonEmptyString(report.siteConditions?.wallMaterial)) missing.push('wall material');
  if (report.siteConditions?.hasElectrical === undefined) missing.push('electrical nearby status');
  if (report.siteConditions?.hasPlumbing === undefined) missing.push('plumbing nearby status');
  if (!isNonEmptyString(report.siteConditions?.accessNotes)) missing.push('access notes');
  if (!isNonEmptyString(report.siteConditions?.obstaclesOrConstraints)) missing.push('obstacles or constraints');

  if (!isNonEmptyString(report.materials)) missing.push('materials');
  if (!isNonEmptyString(report.finishes)) missing.push('finishes');
  if (!isNonEmptyString(report.preferredDesign)) missing.push('preferred design');
  if ((report.photoKeys?.length || 0) === 0) missing.push('site photos');
  if ((report.initialDesignKeys?.length || 0) === 0) missing.push('initial design files');
  if (!isNonEmptyString(report.initialDesignNotes)) missing.push('initial design notes');

  return [...new Set(missing)];
}

/**
 * Build a filter condition that excludes draft reports whose appointment has been cancelled.
 * Returns a condition to merge into the Mongo query.
 */
async function excludeCancelledDrafts(): Promise<Record<string, unknown>> {
  const cancelledIds = await Appointment.find(
    { status: AppointmentStatus.CANCELLED },
    { _id: 1 },
  ).lean();

  if (cancelledIds.length === 0) return {};

  // Exclude drafts tied to cancelled appointments; non-draft reports are preserved.
  return {
    $nor: [
      {
        status: VisitReportStatus.DRAFT,
        appointmentId: { $in: cancelledIds.map((a) => a._id) },
      },
    ],
  };
}

// ── Auto-create Draft (called when Agent confirms appointment) ──
// Creates a single initial report. Sales staff can add more via createReport().
// If customerSiteDetails is provided (customer filled in pre-visit info), pre-populate the report.

export async function autoCreateDraft(
  appointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  visitType: string,
  customerSiteDetails?: ICustomerSiteDetails,
  serviceTypeOverride?: string,
  serviceTypeCustomOverride?: string,
  linkedProjectId?: Types.ObjectId | string,
): Promise<void> {
  // Check if any report already exists for this appointment
  const existing = await VisitReport.findOne({ appointmentId });
  if (existing) {
    // Backfill existing draft with consultation data if it was created before pre-population
    if (
      existing.status === VisitReportStatus.DRAFT &&
      linkedProjectId &&
      !existing.linkedProjectId &&
      customerSiteDetails
    ) {
      existing.linkedProjectId = linkedProjectId as Types.ObjectId;
      if (customerSiteDetails.serviceTypes?.[0]) existing.serviceType = customerSiteDetails.serviceTypes[0];
      if (customerSiteDetails.serviceTypeCustom) existing.serviceTypeCustom = customerSiteDetails.serviceTypeCustom;
      if (customerSiteDetails.materials) existing.materials = customerSiteDetails.materials;
      if (customerSiteDetails.finishes) existing.finishes = customerSiteDetails.finishes;
      if (customerSiteDetails.preferredDesign) existing.preferredDesign = customerSiteDetails.preferredDesign;
      if (customerSiteDetails.customerRequirements) existing.customerRequirements = customerSiteDetails.customerRequirements;
      if (customerSiteDetails.notes) existing.notes = customerSiteDetails.notes;
      await existing.save();
    }
    return;
  }

  // Build report data, pre-populating from customer site details if available
  const reportData: Record<string, any> = {
    appointmentId,
    customerId,
    salesStaffId,
    status: VisitReportStatus.DRAFT,
    visitType,
    ...(linkedProjectId && { linkedProjectId }),
    serviceType: customerSiteDetails?.serviceTypes?.[0] || serviceTypeOverride || ServiceType.CUSTOM,
    serviceTypeCustom: customerSiteDetails?.serviceTypeCustom || serviceTypeCustomOverride,
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

  // Appointment must be completed to add reports
  if (appointment.status !== AppointmentStatus.COMPLETED) {
    throw AppError.badRequest('Appointment must be marked as complete before adding visit reports');
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

  // Fetch sample projects for the customer
  const customerId = report.customerId instanceof Object ? (report.customerId as any)._id : report.customerId;
  const customerProjects = await Project.find({ customerId })
    .select('title serviceType status')
    .sort({ createdAt: -1 })
    .limit(2);

  const sampleProjects = customerProjects.map((p) => ({
    projectId: String(p._id),
    title: p.title || p.serviceType || 'Project',
    serviceType: p.serviceType,
    status: p.status,
    path: `/projects/${p._id}`,
  }));

  return {
    ...report.toObject(),
    sampleProjects,
  };
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
  const filter: Record<string, unknown> = { salesStaffId, ...(await excludeCancelledDrafts()) };
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
  const filter: Record<string, unknown> = { ...(await excludeCancelledDrafts()) };
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

  if (report.visitType === 'consultation') {
    report.initialDesignKeys = [];
    report.initialDesignNotes = undefined;
    delete changes.initialDesignKeys;
    delete changes.initialDesignNotes;
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

  // Ensure the linked appointment is in a valid status before allowing submission
  const appt = await Appointment.findById(report.appointmentId);
  if (!appt) throw AppError.notFound('Linked appointment not found');

  if (appt.status !== AppointmentStatus.COMPLETED) {
    throw AppError.badRequest(
      'The appointment must be marked as complete before submitting reports',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Block submission for ocular visits with unpaid cash fees (outside NCR)
  if (
    report.visitType === 'ocular' &&
    appt.ocularFeePaymentChoice === OcularFeePaymentChoice.CASH &&
    !appt.ocularFeeBreakdown?.isWithinNCR &&
    !appt.ocularFeePaid
  ) {
    throw AppError.badRequest(
      'The ocular visit fee must be collected and verified by the cashier before submitting this report.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (report.visitType === 'ocular') {
    const missingFields = getIncompleteOcularFields(report);
    if (missingFields.length > 0) {
      throw AppError.badRequest(
        `You have not yet provided information on: ${missingFields.join(', ')}.`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
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

  if (report.visitType === 'consultation') {
    // ── Consultation: auto-create DRAFT project, notify agent about recommended ocular ──
    const existingProject = await Project.findOne({ visitReportId: report._id });
    if (!existingProject) {
      const serviceLabel = report.serviceTypeCustom || report.serviceType || 'General Fabrication';
      const customerNotes = (appt.customerNotes || '').trim();
      const notesNormalized = customerNotes.toLowerCase();
      const serviceLabelNormalized = serviceLabel.toLowerCase();
      const titleBase = customerNotes && notesNormalized !== serviceLabelNormalized
        ? customerNotes
        : serviceLabel;
      const project = await Project.create({
        appointmentId: report.appointmentId,
        visitReportId: report._id,
        customerId: report.customerId,
        salesStaffId: report.salesStaffId,
        title: titleBase,
        serviceType: serviceLabel,
        description: report.customerRequirements || report.notes || 'Created from consultation',
        siteAddress: appt.customerAddress || 'TBD',
        measurements: report.measurements,
        materialType: report.materials,
        finishColor: report.finishes,
        quantity: 1,
        notes: report.notes,
        designReviewStatus: 'not_required',
        status: ProjectStatus.DRAFT,
        mediaKeys: [...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys],
      });

      await AuditLog.create({
        action: AuditAction.PROJECT_CREATED,
        actorId: salesStaffId,
        targetType: 'project',
        targetId: project._id,
        details: { triggeredBy: 'system', reason: 'consultation_submitted', visitReportId: reportId },
        ipAddress: ip,
        userAgent: ua,
      });

      // Notify agent with recommended ocular info
      const formatOcularSlot = (slot: string) => {
        const h = parseInt(slot.split(':')[0]);
        return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
      };
      const ocularDateInfo = report.recommendedOcularDate
        ? ` Recommended ocular date: ${report.recommendedOcularDate.toISOString().split('T')[0]}${report.recommendedOcularSlot ? ` at ${formatOcularSlot(report.recommendedOcularSlot)}` : ''}.`
        : '';
      await notifyRole(
        Role.APPOINTMENT_AGENT,
        NotificationCategory.APPOINTMENT,
        'Consultation Completed — Schedule Ocular',
        `Consultation report submitted for "${serviceLabel}". A DRAFT project has been created.${ocularDateInfo} Schedule an ocular visit for the customer.`,
        `/appointments/${appt._id}`,
      );

      // Notify admin
      await notifyRole(
        Role.ADMIN,
        NotificationCategory.PROJECT,
        'New Draft Project from Consultation',
        `A new draft project "${serviceLabel}" has been created from a consultation. Awaiting ocular visit.`,
        `/projects/${project._id}`,
      );

      // Notify customer
      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Consultation Complete',
        `Your consultation has been completed and project "${serviceLabel}" has been created. An ocular visit will be scheduled.`,
        `/projects/${project._id}`,
      );

      // Mark consultation as ready_for_ocular once the consultation report is submitted.
      appt.consultationReportSubmitted = true;
      if (appt.status === AppointmentStatus.COMPLETED) {
        appointmentStateMachine.assertTransition(
          appt.status,
          AppointmentStatus.READY_FOR_OCULAR,
        );
        appt.status = AppointmentStatus.READY_FOR_OCULAR;
      }
      await appt.save();

      // If consultation included a recommended ocular schedule, auto-create ocular request
      // so the customer can immediately submit site pin/address from their account.
      const recommendedOcularDate = report.recommendedOcularDate
        ? report.recommendedOcularDate.toISOString().split('T')[0]
        : undefined;
      const recommendedOcularSlot = report.recommendedOcularSlot;

      if (recommendedOcularDate && recommendedOcularSlot) {
        const hasActiveOcular = await Appointment.exists({
          customerId: report.customerId,
          type: AppointmentType.OCULAR,
          status: {
            $in: [
              AppointmentStatus.REQUESTED,
              AppointmentStatus.CONFIRMED,
              AppointmentStatus.PREPARING,
              AppointmentStatus.ON_THE_WAY,
              AppointmentStatus.RESCHEDULE_REQUESTED,
            ],
          },
        });

        if (!hasActiveOcular) {
          const ocularAppointment = await Appointment.create({
            customerId: report.customerId,
            type: AppointmentType.OCULAR,
            date: recommendedOcularDate,
            slotCode: recommendedOcularSlot,
            status: AppointmentStatus.REQUESTED,
            salesStaffId: report.salesStaffId,
            bookedBy: report.salesStaffId,
            customerNotes: `Ocular follow-up scheduled from consultation report ${report._id}`,
          });

          if (appt.status === AppointmentStatus.READY_FOR_OCULAR) {
            appointmentStateMachine.assertTransition(
              appt.status,
              AppointmentStatus.COMPLETED,
            );
            appt.status = AppointmentStatus.COMPLETED;
            await appt.save();
          }

          await AuditLog.create({
            action: AuditAction.APPOINTMENT_CREATED,
            actorId: salesStaffId,
            targetType: 'appointment',
            targetId: ocularAppointment._id,
            details: {
              triggeredBy: 'system',
              reason: 'consultation_report_recommended_ocular',
              sourceVisitReportId: report._id,
            },
            ipAddress: ip,
            userAgent: ua,
          });

          const readableSlot = formatOcularSlot(recommendedOcularSlot);

          await createAndSendNotification(
            report.customerId,
            NotificationCategory.APPOINTMENT,
            'Ocular Visit Needs Your Location Confirmation',
            `An ocular visit is ready for ${recommendedOcularDate} at ${readableSlot}. Open the appointment and submit your site map pin/address to continue.`,
            `/appointments/${ocularAppointment._id}`,
          );

          await createAndSendNotification(
            report.customerId,
            NotificationCategory.SYSTEM,
            'Action Required: Submit Ocular Map Address',
            `Please confirm your ocular appointment by submitting your map pin/address for ${recommendedOcularDate} at ${readableSlot}.`,
            `/appointments/${ocularAppointment._id}`,
          );
        }
      }
    }
  } else {
    // ── Ocular: update existing project with measurements, transition DRAFT → SUBMITTED ──
    const linkedProject = report.linkedProjectId
      ? await Project.findById(report.linkedProjectId)
      : await Project.findOne({ visitReportId: { $ne: report._id }, appointmentId: { $exists: true }, customerId: report.customerId, status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] } }).sort({ createdAt: -1 });

    if (linkedProject) {
      // Update project with ocular data
      if (report.measurements) linkedProject.measurements = report.measurements;
      if (report.materials) linkedProject.materialType = report.materials;
      if (report.finishes) linkedProject.finishColor = report.finishes;
      if (report.notes) linkedProject.notes = report.notes;
      if (report.initialDesignKeys?.length) linkedProject.initialDesignKeys = report.initialDesignKeys;
      if (report.initialDesignNotes) linkedProject.initialDesignNotes = report.initialDesignNotes;
      if (report.initialDesignKeys?.length || report.initialDesignNotes?.trim()) {
        linkedProject.designReviewStatus = linkedProject.designReviewStatus === 'approved'
          ? 'approved'
          : 'pending';
      }
      if (report.siteConditions) (linkedProject as any).siteConditions = report.siteConditions;
      linkedProject.mediaKeys = [...(linkedProject.mediaKeys || []), ...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys];
      if (appt.formattedAddress) linkedProject.siteAddress = appt.formattedAddress;
      // Point the project's visitReportId to the ocular report so the project page shows on-site data
      linkedProject.visitReportId = report._id;

      // Transition DRAFT → SUBMITTED
      if (linkedProject.status === ProjectStatus.DRAFT) {
        linkedProject.status = ProjectStatus.SUBMITTED;
      }

      await linkedProject.save();

      await AuditLog.create({
        action: AuditAction.PROJECT_UPDATED,
        actorId: salesStaffId,
        targetType: 'project',
        targetId: linkedProject._id,
        details: { triggeredBy: 'system', reason: 'ocular_report_submitted', visitReportId: reportId },
        ipAddress: ip,
        userAgent: ua,
      });

      // Notify admin/engineers
      await notifyRole(
        Role.ADMIN,
        NotificationCategory.PROJECT,
        'Project Updated from Ocular',
        `Project "${linkedProject.serviceType || linkedProject.title}" has been updated with ocular measurements and is now SUBMITTED. Assign an engineer.`,
        `/projects/${linkedProject._id}`,
      );

      await notifyRole(
        Role.ENGINEER,
        NotificationCategory.PROJECT,
        'New Project Submitted',
        `Project "${linkedProject.serviceType || linkedProject.title}" has been submitted with site measurements and is ready for blueprint work.`,
        `/projects/${linkedProject._id}`,
      );

      // Notify customer
      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Ocular Visit Complete',
        `Your ocular visit report has been submitted and your project "${linkedProject.serviceType || linkedProject.title}" is now being processed.`,
        `/projects/${linkedProject._id}`,
      );
    } else {
      // Fallback: no linked project found — create one as SUBMITTED (legacy behavior)
      const existingProject = await Project.findOne({ visitReportId: report._id });
      if (!existingProject) {
        const serviceLabel = report.serviceTypeCustom || report.serviceType || 'General Fabrication';
        const customerNotes = (appt.customerNotes || '').trim();
        const notesNormalized = customerNotes.toLowerCase();
        const serviceLabelNormalized = serviceLabel.toLowerCase();
        const titleBase = customerNotes && notesNormalized !== serviceLabelNormalized
          ? customerNotes
          : serviceLabel;
        const project = await Project.create({
          appointmentId: report.appointmentId,
          visitReportId: report._id,
          customerId: report.customerId,
          salesStaffId: report.salesStaffId,
          title: titleBase,
          serviceType: serviceLabel,
          description: report.customerRequirements || report.notes || 'Created from visit report',
          siteAddress: appt.customerAddress || 'TBD',
          measurements: report.measurements,
          materialType: report.materials,
          finishColor: report.finishes,
          quantity: 1,
          notes: report.notes,
          initialDesignKeys: report.initialDesignKeys || [],
          initialDesignNotes: report.initialDesignNotes,
          designReviewStatus: (report.initialDesignKeys?.length || report.initialDesignNotes) ? 'pending' : 'not_required',
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

        await notifyRole(
          Role.ADMIN,
          NotificationCategory.PROJECT,
          'New Project from Visit Report',
          `A new project "${serviceLabel}" has been created from a visit report. Assign an engineer.`,
          `/projects/${project._id}`,
        );

        await createAndSendNotification(
          report.customerId,
          NotificationCategory.PROJECT,
          'Project Created',
          `Your project "${serviceLabel}" has been created from the visit report. An engineer will be assigned shortly.`,
          `/projects/${project._id}`,
        );
      }
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

export async function reopenReportForRepair(
  reportId: string,
  input: ReopenVisitReportInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.visitType !== 'ocular') {
    throw AppError.badRequest('Only ocular reports can be reopened for repair');
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF) && report.salesStaffId.toString() === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only the assigned sales staff or an admin can reopen this ocular report');
  }

  if (![VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED].includes(report.status)) {
    throw AppError.badRequest('Only submitted or completed ocular reports can be reopened for repair');
  }

  const reason = input.reason.trim();
  report.status = VisitReportStatus.RETURNED;
  report.returnReason = reason;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_RETURNED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { reason, reopenedForRepair: true },
    ipAddress: ip,
    userAgent: ua,
  });

  const linkedProject = report.linkedProjectId
    ? await Project.findById(report.linkedProjectId)
    : await Project.findOne({ visitReportId: report._id });

  if (linkedProject) {
    await notifyRole(
      Role.ADMIN,
      NotificationCategory.PROJECT,
      'Ocular Report Reopened for Repair',
      `Ocular report for project "${linkedProject.title}" was reopened for repair. Reason: ${reason}`,
      `/visit-reports/${report._id}`,
    );

    for (const engineerId of linkedProject.engineerIds) {
      await createAndSendNotification(
        engineerId,
        NotificationCategory.PROJECT,
        'Ocular Report Under Repair',
        `The ocular report for project "${linkedProject.title}" was reopened for repair. Engineering should wait for the corrected site data before relying on it.`,
        `/projects/${linkedProject._id}`,
      );
    }
  }

  if (isAdmin && report.salesStaffId.toString() !== actorId) {
    await createAndSendNotification(
      report.salesStaffId,
      NotificationCategory.PROJECT,
      'Ocular Report Reopened for Repair',
      `An admin reopened your ocular report for repair. Reason: ${reason}`,
      `/visit-reports/${report._id}`,
    );
  }

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
