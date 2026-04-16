import { format, parse, isAfter, isBefore, startOfDay, addMinutes, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  Appointment, SlotLock, User, AuditLog, Holiday, SalesAvailability, Config, BlockedSlot,
  VisitReport, VisitReportStatus, Project,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, Role, AuditAction,
  NotificationCategory, PaymentMethod, OcularFeePaymentChoice, ProjectStatus, SLOT_CODES, type SlotCode,
} from '../../utils/constants.js';
import { appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { sendAppointmentConfirmedEmail } from '../notifications/email.service.js';
import { autoCreateDraft as autoCreateVisitReport } from '../visit-reports/visit-reports.service.js';
import { computeOcularFee, reverseGeocode } from '../maps/maps.service.js';
import { createCheckoutSession, retrieveCheckoutSession } from '../../services/paymongo.service.js';
import { logger } from '../../utils/logger.js';
import { formatCurrency } from '../../utils/helpers.js';
import type {
  RequestAppointmentInput,
  AgentCreateAppointmentInput,
  ConfirmAppointmentInput,
  RescheduleRequestInput,
  RescheduleCompleteInput,
  RecordOcularFeeInput,
  AvailableSlotsQuery,
  SubmitSiteDetailsInput,
  AgentCreateOcularInput,
  SubmitOcularLocationInput,
  AgentFinalizeOcularInput,
} from './appointments.validation.js';
import type { Types } from 'mongoose';

const TZ = 'Asia/Manila';

// ── Helpers ──

async function getConfigValue<T>(key: string, defaultVal: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : defaultVal;
}

async function getLatestEligibleConsultationForOcular(customerId: string) {
  const consultation = await Appointment.findOne({
    customerId,
    type: AppointmentType.OFFICE,
    salesStaffId: { $exists: true },
    status: AppointmentStatus.COMPLETED,
  }).sort({ createdAt: -1 });

  if (!consultation) return null;

  const consultationReport = await VisitReport.findOne({
    appointmentId: consultation._id,
    visitType: 'consultation',
    status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
  }).sort({ createdAt: -1 });

  if (!consultationReport) return null;

  return { consultation, consultationReport };
}

function formatSlotTime(slotCode: string): string {
  const hour = parseInt(slotCode.split(':')[0]);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${displayHour}:00 ${ampm}`;
}

async function assertNoActiveAppointment(customerId: string): Promise<void> {
  const active = await Appointment.findOne({
    customerId,
    status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.RESCHEDULE_REQUESTED] },
  });
  if (active) {
    throw AppError.conflict(
      'You already have an active appointment. Please complete or cancel it first.',
      ErrorCode.DUPLICATE_ENTRY,
      {
        activeAppointmentId: active._id.toString(),
        activeAppointmentStatus: active.status,
        activeAppointmentType: active.type,
        activeAppointmentDate: active.date,
        activeAppointmentSlotCode: active.slotCode,
      },
    );
  }
}

async function assertDateAvailable(dateStr: string): Promise<void> {
  // Check it's not in the past
  const now = toZonedTime(new Date(), TZ);
  const target = parse(dateStr, 'yyyy-MM-dd', new Date());
  if (isBefore(target, startOfDay(now))) {
    throw AppError.badRequest('Cannot book appointments in the past');
  }

  // Enforce 3-day minimum advance booking
  const minBookingDate = startOfDay(addDays(now, 3));
  if (isBefore(target, minBookingDate)) {
    throw AppError.badRequest('Appointments must be booked at least 3 days in advance');
  }

  // Check it's not a weekend (0 = Sun, 6 = Sat)
  const day = target.getDay();
  if (day === 0 || day === 6) {
    throw AppError.badRequest('Appointments are not available on weekends');
  }

  // Check it's not a holiday
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    throw AppError.badRequest(`${dateStr} is a holiday: ${holiday.name}`);
  }
}

async function assertSlotAvailable(dateStr: string, slotCode: string, type: string): Promise<void> {
  const blocked = await BlockedSlot.exists({ date: dateStr, slotCode, type });
  if (blocked) {
    throw AppError.conflict('This slot has been blocked by an administrator', ErrorCode.SLOT_LOCKED);
  }

  const booked = await Appointment.countDocuments({
    date: dateStr,
    slotCode,
    type,
    status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED] },
  });
  if (booked > 0) {
    throw AppError.conflict('This slot is no longer available', ErrorCode.SLOT_LOCKED);
  }
}

async function assertSalesAvailable(salesId: string, dateStr: string): Promise<void> {
  const availability = await SalesAvailability.findOne({ salesStaffId: salesId });
  if (availability?.unavailableDates.includes(dateStr)) {
    throw AppError.badRequest('Selected sales staff is unavailable on this date');
  }
}

interface OcularVisitComputation {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  customerLocation: { lat: number; lng: number };
  distanceKm: number;
  ocularFee: number;
  ocularFeeBreakdown: {
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
    total: number;
    isWithinNCR: boolean;
  };
}

async function resolveOcularVisitData(
  type: AppointmentType,
  formattedAddress: string | undefined,
  location: { lat: number; lng: number } | undefined,
): Promise<OcularVisitComputation | null> {
  if (type !== AppointmentType.OCULAR) return null;
  if (!location) {
    throw AppError.badRequest('Pinned map coordinates are required for ocular visits');
  }

  const feeResult = await computeOcularFee(location);
  let resolvedAddress = formattedAddress?.trim() ?? '';
  if (!resolvedAddress) {
    try {
      resolvedAddress = (await reverseGeocode(location)).formattedAddress;
    } catch {
      resolvedAddress = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
    }
  }

  return {
    latitude: location.lat,
    longitude: location.lng,
    formattedAddress: resolvedAddress,
    customerLocation: location,
    distanceKm: feeResult.route.distanceKm,
    ocularFee: feeResult.fee.total,
    ocularFeeBreakdown: feeResult.fee,
  };
}

// ── Slot Lock with anti-race ──

async function lockSlot(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
  lockedBy: string,
): Promise<void> {
  try {
    await SlotLock.create({
      date: dateStr,
      slotCode,
      salesId,
      lockedBy,
      confirmed: false,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min TTL
    });
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 11000) {
      throw AppError.conflict('This slot is no longer available', ErrorCode.SLOT_LOCKED);
    }
    throw error;
  }
}

async function confirmSlotLock(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
  appointmentId: Types.ObjectId,
): Promise<void> {
  await SlotLock.updateOne(
    { date: dateStr, slotCode, salesId },
    { confirmed: true, appointmentId },
  );
}

async function releaseSlotLock(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
): Promise<void> {
  await SlotLock.deleteOne({ date: dateStr, slotCode, salesId });
}

// ── Get Available Slots ──

export async function getAvailableSlots(query: AvailableSlotsQuery) {
  const { date, type } = query;
  await assertDateAvailable(date);

  // 1 booking per slot; also check admin/agent blocked slots
  const slots = await Promise.all(
    SLOT_CODES.map(async (slotCode) => {
      const booked = await Appointment.countDocuments({
        date,
        slotCode,
        type,
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED] },
      });
      const blocked = await BlockedSlot.exists({ date, slotCode, type });
      return {
        slotCode,
        time: formatSlotTime(slotCode),
        available: booked === 0 && !blocked,
        blocked: !!blocked,
      };
    }),
  );

  return { date, type, slots };
}

// ── Customer: Request Appointment ──

export async function requestAppointment(
  input: RequestAppointmentInput,
  customerId: string,
  userRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!userRoles.includes(Role.CUSTOMER)) {
    throw AppError.forbidden('Only customers can request appointments from this endpoint');
  }

  // Customer self-booking is consultation-first only.
  if (input.type === AppointmentType.OCULAR) {
    throw AppError.badRequest(
      'Ocular visits cannot be booked directly by customers. Please book an office consultation first.',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'customer_booking',
        reason: 'consultation_first_only',
        action: 'book_office_consultation_first',
      },
    );
  }

  await assertNoActiveAppointment(customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, input.type);

  // Office-only: no ocular visit data needed
  const appointment = await Appointment.create({
    customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerNotes: input.purpose,
    serviceType: input.serviceType,
    serviceTypeCustom: input.serviceTypeCustom,
    bookedBy: customerId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { type: input.type, date: input.date, slotCode: input.slotCode },
    ipAddress: ip,
    userAgent: ua,
  });

  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'New Appointment Request',
    `A new ${input.type} appointment has been requested for ${input.date} at ${formatSlotTime(input.slotCode)}`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Create Appointment on behalf of customer ──

export async function agentCreateAppointment(
  input: AgentCreateAppointmentInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  if (input.type !== AppointmentType.OFFICE) {
    throw AppError.badRequest(
      'Appointment agents can only create the first office consultation for a customer. Ocular scheduling is handled by sales staff after consultation.',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'agent_create_appointment',
        reason: 'office_consultation_only',
        action: 'use_sales_staff_ocular_flow',
      },
    );
  }

  const customer = await User.findById(input.customerId);
  if (!customer || !customer.roles.includes(Role.CUSTOMER)) {
    throw AppError.notFound('Customer not found');
  }

  await assertNoActiveAppointment(input.customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, input.type);

  const appointment = await Appointment.create({
    customerId: input.customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerNotes: input.purpose,
    addressStructured: input.addressStructured,
    bookedBy: agentId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      type: input.type,
      date: input.date,
      slotCode: input.slotCode,
      customerId: input.customerId,
      createdByAgent: true,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    input.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Created',
    `An appointment has been booked for you on ${input.date} at ${formatSlotTime(input.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Confirm Appointment ──

export async function confirmAppointment(
  appointmentId: string,
  input: ConfirmAppointmentInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);

  // Block confirmation for non-NCR ocular appointments if the ocular fee hasn't been paid
  // Exception: if customer chose cash, the sales staff will collect it during the visit
  if (
    appointment.type === AppointmentType.OCULAR &&
    appointment.ocularFeeBreakdown &&
    !appointment.ocularFeeBreakdown.isWithinNCR &&
    !appointment.ocularFeePaid &&
    appointment.ocularFeePaymentChoice !== OcularFeePaymentChoice.CASH
  ) {
    throw AppError.badRequest(
      'Ocular fee must be paid before confirming this appointment. The location is outside Metro Manila.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Assign or re-assign sales staff
  const salesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!salesStaff) throw AppError.notFound('Sales staff not found');
  await assertSalesAvailable(input.salesStaffId, appointment.date);

  // If ocular and sales changed, update slot lock
  if (appointment.type === AppointmentType.OCULAR) {
    if (appointment.salesStaffId && appointment.salesStaffId.toString() !== input.salesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
    }
    await lockSlot(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, agentId);
    await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, appointment._id);
  }

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.salesStaffId = salesStaff._id;
  appointment.confirmedBy = agentId as unknown as Types.ObjectId;
  if (input.internalNotes) appointment.internalNotes = input.internalNotes;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { salesStaffId: input.salesStaffId },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(appointment.customerId);
  if (customer) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Confirmed',
      `Your appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been confirmed.`,
      `/appointments/${appointment._id}`,
    );

    await sendAppointmentConfirmedEmail(customer.email, {
      date: appointment.date,
      time: formatSlotTime(appointment.slotCode),
      type: appointment.type === AppointmentType.OCULAR ? 'Ocular Visit' : 'Office Visit',
    });
  }

  // Notify sales staff
  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.APPOINTMENT,
    'New Appointment Assigned',
    `You have been assigned an appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  // ── Auto-create VisitReport (DRAFT) for the assigned sales staff ──
  await autoCreateVisitReport(
    appointment._id,
    appointment.customerId,
    salesStaff._id,
    appointment.type === AppointmentType.OCULAR ? 'ocular' : 'consultation',
    appointment.customerSiteDetails || undefined,
    appointment.serviceType,
    appointment.serviceTypeCustom,
  );

  return appointment;
}

// ── Customer: Submit Site Details ──

export async function submitSiteDetails(
  appointmentId: string,
  input: SubmitSiteDetailsInput,
  customerId: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Must belong to this customer
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  // Must be in REQUESTED status (not yet confirmed)
  if (appointment.status !== AppointmentStatus.REQUESTED) {
    throw AppError.badRequest('Site details can only be submitted for pending appointments');
  }

  // Must not already be submitted
  if (appointment.siteDetailsStatus === 'submitted') {
    throw AppError.badRequest('Site details have already been submitted for this appointment');
  }

  // Office appointments: photos & reference images are recommended but not mandatory
  // Customers can update them later from the site details page

  appointment.customerSiteDetails = input;
  appointment.siteDetailsStatus = 'submitted';
  await appointment.save();

  // Notify appointment agents that site details have been submitted
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Site Details Submitted',
    `Customer has submitted site details for ${appointment.type} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Customer: Skip Site Details (ocular only) ──

export async function skipSiteDetails(
  appointmentId: string,
  customerId: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Only ocular appointments can skip site details');
  }

  if (appointment.status !== AppointmentStatus.REQUESTED) {
    throw AppError.badRequest('Site details can only be skipped for pending appointments');
  }

  appointment.siteDetailsStatus = 'skipped';
  await appointment.save();

  return appointment;
}

// ── Agent: Create Ocular Appointment (from consultation context) ──

export async function agentCreateOcular(
  input: AgentCreateOcularInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!actorRoles.includes(Role.SALES_STAFF)) {
    throw AppError.forbidden(
      'Only sales staff can schedule ocular visits after consultation. Appointment agents should assign consultation first.',
      ErrorCode.FORBIDDEN,
      {
        flow: 'staff_direct_ocular',
        reason: 'only_sales_staff_can_schedule_ocular_after_consultation',
        action: 'assign_sales_staff_for_consultation_first',
      },
    );
  }

  const customer = await User.findById(input.customerId);
  if (!customer || !customer.roles.includes(Role.CUSTOMER)) {
    throw AppError.notFound('Customer not found');
  }

  await assertNoActiveAppointment(input.customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, AppointmentType.OCULAR);

  const consultationContext = await getLatestEligibleConsultationForOcular(input.customerId);
  if (!consultationContext?.consultation.salesStaffId) {
    throw AppError.badRequest(
      'A completed consultation with submitted consultation details is required before scheduling an ocular visit',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'staff_direct_ocular',
        reason: 'completed_consultation_with_report_required',
        action: 'complete_consultation_then_submit_consultation_report',
      },
    );
  }

  if (consultationContext.consultation.salesStaffId.toString() !== actorId) {
    throw AppError.forbidden(
      'Only the sales staff assigned in the completed consultation can schedule this ocular visit',
      ErrorCode.FORBIDDEN,
      {
        flow: 'staff_direct_ocular',
        reason: 'staff_assignment_mismatch',
        action: 'use_assigned_consultation_staff_account',
      },
    );
  }

  const preassignedSalesStaffId: string | undefined = actorId;

  // Create ocular WITHOUT location/fee — customer provides these later
  const appointment = await Appointment.create({
    customerId: input.customerId,
    type: AppointmentType.OCULAR,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    salesStaffId: preassignedSalesStaffId,
    customerNotes: input.visitReportId
      ? `Ocular follow-up from consultation report ${input.visitReportId}`
      : 'Ocular visit scheduled directly by sales staff',
    bookedBy: actorId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      type: AppointmentType.OCULAR,
      date: input.date,
      slotCode: input.slotCode,
      customerId: input.customerId,
      visitReportId: input.visitReportId,
      createdByAgent: false,
      createdBySalesStaffDirect: true,
      isOcularFollowUp: true,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer to provide their location
  await createAndSendNotification(
    input.customerId,
    NotificationCategory.APPOINTMENT,
    'Ocular Visit Scheduled',
    `An ocular visit has been scheduled for ${input.date} at ${formatSlotTime(input.slotCode)}. Please provide your site address.`,
    `/appointments/${appointment._id}`,
  );

  if (preassignedSalesStaffId) {
    await createAndSendNotification(
      preassignedSalesStaffId,
      NotificationCategory.APPOINTMENT,
      'Direct Ocular Booking Created',
      `You scheduled an ocular visit for ${input.date} at ${formatSlotTime(input.slotCode)}. Waiting for customer location submission.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Customer: Submit Ocular Location ──

export async function customerSubmitOcularLocation(
  appointmentId: string,
  input: SubmitOcularLocationInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('This is not an ocular appointment');
  }

  if (appointment.status !== AppointmentStatus.REQUESTED) {
    throw AppError.badRequest('Location can only be submitted for pending ocular appointments');
  }

  // Validate Philippines bounds
  const { lat, lng } = input.customerLocation;
  if (lat < 4.5 || lat > 21.5 || lng < 116.0 || lng > 127.0) {
    throw AppError.badRequest('Location must be within the Philippines');
  }

  // Compute fee and resolve address
  const ocularVisitData = await resolveOcularVisitData(
    AppointmentType.OCULAR,
    input.formattedAddress,
    input.customerLocation,
  );

  if (!ocularVisitData) {
    throw AppError.badRequest('Could not compute ocular visit data');
  }

  appointment.latitude = ocularVisitData.latitude;
  appointment.longitude = ocularVisitData.longitude;
  appointment.formattedAddress = ocularVisitData.formattedAddress;
  appointment.customerAddress = ocularVisitData.formattedAddress;
  appointment.customerLocation = ocularVisitData.customerLocation;
  appointment.distanceKm = ocularVisitData.distanceKm;
  appointment.ocularFee = ocularVisitData.ocularFee;
  appointment.ocularFeeBreakdown = ocularVisitData.ocularFeeBreakdown;
  if (input.addressStructured) appointment.addressStructured = input.addressStructured;

  // Determine fee status
  const isWithinNCR = ocularVisitData.ocularFeeBreakdown.isWithinNCR;
  if (!isWithinNCR && ocularVisitData.ocularFee > 0) {
    appointment.ocularFeeStatus = 'pending';
  }

  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_LOCATION_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      lat: input.customerLocation.lat,
      lng: input.customerLocation.lng,
      distanceKm: ocularVisitData.distanceKm,
      ocularFee: ocularVisitData.ocularFee,
      isWithinNCR,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Customer Location Submitted',
      `Customer submitted their location for ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Agent: Finalize Ocular Appointment ──

export async function agentFinalizeOcular(
  appointmentId: string,
  input: AgentFinalizeOcularInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!actorRoles.includes(Role.SALES_STAFF)) {
    throw AppError.forbidden(
      'Only sales staff can finalize ocular visits',
      ErrorCode.FORBIDDEN,
    );
  }

  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('This is not an ocular appointment');
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);

  // Ensure customer has provided location
  if (!appointment.customerLocation && !appointment.latitude) {
    throw AppError.badRequest('Customer has not yet submitted their location');
  }

  // Ensure ocular fee is resolved (paid, within NCR, or cash will be collected on-site)
  const isWithinNCR = appointment.ocularFeeBreakdown?.isWithinNCR;
  const isCashOnSite = appointment.ocularFeeStatus === 'cash_pending';
  if (!isWithinNCR && !appointment.ocularFeePaid && !isCashOnSite) {
    throw AppError.badRequest(
      'Ocular fee must be paid before finalizing. The location is outside Metro Manila.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!appointment.salesStaffId) {
    throw AppError.badRequest(
      'This ocular visit has no assigned sales staff. Please re-schedule it through the assigned sales staff workflow.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (appointment.salesStaffId.toString() !== actorId) {
    throw AppError.forbidden(
      'Only the assigned sales staff can finalize this ocular visit',
      ErrorCode.FORBIDDEN,
    );
  }

  const resolvedSalesStaffId = actorId;

  const salesStaff = await User.findOne({
    _id: actorId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!salesStaff) throw AppError.notFound('Sales staff not found');

  await assertSalesAvailable(resolvedSalesStaffId, appointment.date);

  // Lock slot for ocular
  await lockSlot(appointment.date, appointment.slotCode as SlotCode, resolvedSalesStaffId, actorId);
  await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, resolvedSalesStaffId, appointment._id);

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.salesStaffId = salesStaff._id;
  appointment.confirmedBy = actorId as unknown as Types.ObjectId;
  if (input.internalNotes) appointment.internalNotes = input.internalNotes;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { salesStaffId: resolvedSalesStaffId, finalizedOcular: true },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customerUser = await User.findById(appointment.customerId);
  if (customerUser) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Ocular Visit Confirmed',
      `Your ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been confirmed.`,
      `/appointments/${appointment._id}`,
    );

    await sendAppointmentConfirmedEmail(customerUser.email, {
      date: appointment.date,
      time: formatSlotTime(appointment.slotCode),
      type: 'Ocular Visit',
    });
  }

  // Notify sales staff
  await createAndSendNotification(
    resolvedSalesStaffId,
    NotificationCategory.APPOINTMENT,
    'Ocular Visit Assigned',
    `You have been assigned an ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  // Find existing project from consultation to link the ocular visit report
  const consultationProject = await Project.findOne({
    customerId: appointment.customerId,
    status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] },
  }).sort({ createdAt: -1 });

  // Pre-populate ocular report with data from the consultation visit report
  let consultationSiteDetails: import('../../models/Appointment.js').ICustomerSiteDetails | undefined;
  if (consultationProject) {
    const consultationReport = await VisitReport.findOne({
      customerId: appointment.customerId,
      visitType: 'consultation',
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    }).sort({ createdAt: -1 }).lean();
    if (consultationReport) {
      consultationSiteDetails = {
        serviceType: consultationReport.serviceType,
        serviceTypeCustom: consultationReport.serviceTypeCustom,
        materials: consultationReport.materials,
        finishes: consultationReport.finishes,
        preferredDesign: consultationReport.preferredDesign,
        customerRequirements: consultationReport.customerRequirements,
        notes: consultationReport.notes,
      };
    }
  }

  // Auto-create VisitReport (DRAFT) for ocular, linked to existing consultation project
  await autoCreateVisitReport(
    appointment._id,
    appointment.customerId,
    salesStaff._id,
    'ocular',
    consultationSiteDetails,
    consultationProject?.serviceType,
    undefined, // serviceTypeCustomOverride
    consultationProject?._id,
  );

  return appointment;
}

// ── Complete Appointment ──

export async function completeAppointment(
  appointmentId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);

  appointment.status = AppointmentStatus.COMPLETED;
  await appointment.save();

  // Release slot lock for ocular appointments
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_COMPLETED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Completed',
    `Your ${appointment.type} appointment on ${appointment.date} has been marked as completed.`,
    `/appointments/${appointment._id}`,
  );

  // Notify appointment agents
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Appointment Completed',
    `${appointment.type.charAt(0).toUpperCase() + appointment.type.slice(1)} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been completed.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Update Visit Status (Preparing / On The Way) ──

export async function updateVisitStatus(
  appointmentId: string,
  newStatus: AppointmentStatus.PREPARING | AppointmentStatus.ON_THE_WAY,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, newStatus);

  appointment.status = newStatus;
  await appointment.save();

  await AuditLog.create({
    action: newStatus === AppointmentStatus.PREPARING ? AuditAction.APPOINTMENT_PREPARING : AuditAction.APPOINTMENT_ON_THE_WAY,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  const statusLabel = newStatus === AppointmentStatus.PREPARING ? 'preparing for your visit' : 'on the way to your location';

  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    newStatus === AppointmentStatus.PREPARING ? 'Staff Preparing' : 'Staff On The Way',
    `Your sales staff is ${statusLabel} for your ${appointment.type} appointment on ${appointment.date}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Mark No-Show ──

export async function markNoShow(
  appointmentId: string,
  internalNotes: string | undefined,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.NO_SHOW);

  appointment.status = AppointmentStatus.NO_SHOW;
  if (internalNotes) appointment.internalNotes = internalNotes;
  await appointment.save();

  // Release slot lock for ocular
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_NO_SHOW,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Marked as No-Show',
    `Your appointment on ${appointment.date} was marked as a no-show.`,
  );

  return appointment;
}

// ── Customer: Request Reschedule ──

export async function requestReschedule(
  appointmentId: string,
  input: RescheduleRequestInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Verify ownership
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only reschedule your own appointments');
  }

  // Check reschedule limit
  if (appointment.rescheduleCount >= appointment.maxReschedules) {
    throw AppError.badRequest(
      `Maximum reschedule limit (${appointment.maxReschedules}) reached`,
      ErrorCode.BOOKING_LIMIT_REACHED,
    );
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.RESCHEDULE_REQUESTED);

  appointment.status = AppointmentStatus.RESCHEDULE_REQUESTED;
  appointment.rescheduleReason = input.reason;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULE_REQUESTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason: input.reason, count: appointment.rescheduleCount },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify agents
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Reschedule Requested',
    `Reschedule requested for appointment on ${appointment.date}. Reason: ${input.reason}`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Complete Reschedule ──

export async function completeReschedule(
  appointmentId: string,
  input: RescheduleCompleteInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.status !== AppointmentStatus.RESCHEDULE_REQUESTED) {
    throw AppError.badRequest('Appointment is not pending reschedule');
  }

  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, appointment.type);

  const salesId = input.salesStaffId || appointment.salesStaffId?.toString();

  if (appointment.type === AppointmentType.OCULAR) {
    if (!salesId) throw AppError.badRequest('Sales staff required for ocular appointments');

    await assertSalesAvailable(salesId, input.date);

    // Release old slot
    if (appointment.salesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
    }

    // Lock new slot
    await lockSlot(input.date, input.slotCode as SlotCode, salesId, agentId);
    await confirmSlotLock(input.date, input.slotCode as SlotCode, salesId, appointment._id);
  }

  const oldDate = appointment.date;
  const oldSlot = appointment.slotCode;

  appointment.date = input.date;
  appointment.slotCode = input.slotCode as SlotCode;
  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.rescheduleCount += 1;
  if (salesId) appointment.salesStaffId = salesId as unknown as Types.ObjectId;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      oldDate, oldSlot: oldSlot,
      newDate: input.date, newSlot: input.slotCode,
      rescheduleCount: appointment.rescheduleCount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Rescheduled',
    `Your appointment has been rescheduled to ${input.date} at ${formatSlotTime(input.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Cancel Appointment ──

export async function cancelAppointment(
  appointmentId: string,
  reason: string | undefined,
  actorId: string,
  actorRole: Role,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Customers can only cancel their own
  if (actorRole === Role.CUSTOMER && appointment.customerId.toString() !== actorId) {
    throw AppError.forbidden('You can only cancel your own appointments');
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CANCELLED);

  appointment.status = AppointmentStatus.CANCELLED;
  appointment.cancellationReason = reason || undefined;
  (appointment as any).cancelledBy = actorId;
  if (reason) appointment.internalNotes = (appointment.internalNotes || '') + ` [Cancelled: ${reason}]`;
  await appointment.save();

  // Release slot lock for ocular
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CANCELLED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason, cancelledBy: actorRole },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify involved parties
  if (actorRole !== Role.CUSTOMER) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled',
      `Your appointment on ${appointment.date} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    );
  }

  if (appointment.salesStaffId && appointment.salesStaffId.toString() !== actorId) {
    await createAndSendNotification(
      appointment.salesStaffId,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled',
      `Appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been cancelled.`,
    );
  }

  // Notify appointment agents when customer cancels
  if (actorRole === Role.CUSTOMER) {
    await notifyRole(
      Role.APPOINTMENT_AGENT,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled by Customer',
      `Customer cancelled their ${appointment.type} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
      `/appointments/${appointment._id}`,
    );
  }

  // Clean up draft visit reports that were auto-created when the appointment was confirmed
  const deletedDrafts = await VisitReport.deleteMany({
    appointmentId: appointment._id,
    status: VisitReportStatus.DRAFT,
  });
  if (deletedDrafts.deletedCount > 0) {
    logger.info(
      `Deleted ${deletedDrafts.deletedCount} draft visit report(s) for cancelled appointment ${appointmentId}`,
    );
  }

  return appointment;
}

// ── Record Ocular Fee Payment ──

// ── Customer: Create PayMongo Checkout for Ocular Fee ──

export async function createOcularFeeCheckout(
  appointmentId: string,
  customerId: string,
  clientOrigin: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  const feeAmount = appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0;
  if (feeAmount <= 0) {
    throw AppError.badRequest('No ocular fee to pay');
  }

  // ⚠️ TESTING ONLY: Override fee to ₱1 for PayMongo test payments. Remove this line for production.
  const chargeAmount = 1; // TODO: change back to `feeAmount` for real payments

  // Always create a fresh checkout session so the success/cancel URLs reflect
  // the client's actual origin (avoids stale localhost URLs in dev)

  const session = await createCheckoutSession({
    amount: chargeAmount, // ⚠️ TESTING ONLY: using chargeAmount (₱1) instead of feeAmount
    description: `Ocular Visit Fee`,
    appointmentId: appointment._id.toString(),
    customerId,
    successUrl: `${clientOrigin}/appointments/${appointment._id}/pay-ocular-fee?status=success`,
    cancelUrl: `${clientOrigin}/appointments/${appointment._id}/pay-ocular-fee?status=cancelled`,
  });

  appointment.paymongoCheckoutSessionId = session.id;
  appointment.paymongoCheckoutUrl = session.attributes.checkout_url;
  appointment.ocularFeeStatus = 'pending';
  appointment.ocularFeePaymentMethod = PaymentMethod.QRPH;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { paymongoSessionId: session.id, ocularFee: feeAmount },
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    appointment,
    checkoutUrl: session.attributes.checkout_url,
    sessionId: session.id,
  };
}

// ── Customer: Request to Pay Ocular Fee via Cash ──

export async function requestOcularCashPayment(
  appointmentId: string,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  const feeAmount = appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0;
  if (feeAmount <= 0) {
    throw AppError.badRequest('No ocular fee to pay');
  }

  // Update status to cash_pending
  appointment.ocularFeeStatus = 'cash_pending';
  appointment.ocularFeePaymentMethod = 'cash' as any;
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: feeAmount, method: 'cash_request' },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify appointment agent and cashier
  const message = `Customer requested to pay ${formatCurrency(feeAmount)} ocular fee via cash for appointment on ${appointment.date}.`;
  
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.PAYMENT,
    'Ocular Fee Cash Request',
    message,
    `/appointments/${appointment._id}`,
  );

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Cash Request',
    message,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ⚠️ TESTING ONLY: Simulate payment without PayMongo. Remove for production.
export async function simulateOcularFeePayment(appointmentId: string, customerId: string) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }
  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Already paid');
  }
  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();
  return appointment;
}
// ⚠️ END TESTING ONLY

// ── Customer: Actively verify ocular fee payment via PayMongo API ──

export async function verifyOcularFeeCheckout(appointmentId: string, customerId: string) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.customerId._id?.toString() !== customerId && appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only verify your own appointments');
  }

  // Already verified
  if (appointment.ocularFeePaid && appointment.ocularFeeStatus === 'verified') {
    return { verified: true, appointment };
  }

  // No checkout session to check
  if (!appointment.paymongoCheckoutSessionId) {
    return { verified: false, appointment };
  }

  // Actively query PayMongo for the checkout session status
  try {
    const session = await retrieveCheckoutSession(appointment.paymongoCheckoutSessionId);
    const payments = session.attributes.payments;

    // Check if any payment succeeded
    const hasPaid = payments && payments.length > 0 && payments.some(
      (p: { attributes?: { status?: string } }) => p.attributes?.status === 'paid',
    );

    if (hasPaid) {
      // Mark as verified — same logic as webhook handler
      appointment.ocularFeePaid = true;
      appointment.ocularFeeStatus = 'verified';
      appointment.ocularFeeDeclineReason = undefined;
      await appointment.save();

      await AuditLog.create({
        action: AuditAction.PAYMENT_VERIFIED,
        actorId: appointment.customerId._id ?? appointment.customerId,
        targetType: 'appointment',
        targetId: appointment._id,
        details: { ocularFee: appointment.ocularFee, verifiedVia: 'paymongo_polling' },
      });

      await createAndSendNotification(
        appointment.customerId._id ?? appointment.customerId,
        NotificationCategory.PAYMENT,
        'Ocular Fee Payment Confirmed',
        `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been confirmed via PayMongo. Your assigned sales staff can now finalize your ocular visit.`,
        `/appointments/${appointment._id}`,
      );

      if (appointment.salesStaffId) {
        await createAndSendNotification(
          appointment.salesStaffId.toString(),
          NotificationCategory.PAYMENT,
          'Ocular Fee Payment Received',
          `Customer has paid the ocular fee of ₱${appointment.ocularFee?.toLocaleString()} for appointment on ${appointment.date}. You can now finalize this ocular visit.`,
          `/appointments/${appointment._id}`,
        );
      }

      return { verified: true, appointment };
    }

    return { verified: false, appointment };
  } catch (err) {
    console.error('[Verify Ocular Fee] Polling failed:', err);
    return { verified: false, appointment };
  }
}

// ── Handle PayMongo Webhook: Payment Paid ──

export async function handlePaymongoPayment(checkoutSessionId: string) {
  const appointment = await Appointment.findOne({
    paymongoCheckoutSessionId: checkoutSessionId,
  }).populate('customerId', 'firstName lastName email');

  if (!appointment) {
    // Not an appointment payment — ignore
    return null;
  }

  if (appointment.ocularFeePaid) {
    // Already verified — idempotent
    return appointment;
  }

  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId: appointment.customerId._id ?? appointment.customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: appointment.ocularFee, verifiedVia: 'paymongo_webhook' },
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId._id ?? appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Confirmed',
    `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been confirmed via PayMongo. Your assigned sales staff can now finalize your ocular visit.`,
    `/appointments/${appointment._id}`,
  );

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Ocular Fee Paid — Ready to Finalize',
      `Ocular fee for appointment on ${appointment.date} has been paid via PayMongo. You can now finalize this ocular visit.`,
      `/appointments/${appointment._id}`,
    );
  }

  // Notify cashiers (for their records)
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Auto-Verified',
    `Ocular fee payment for appointment on ${appointment.date} was automatically verified via PayMongo.`,
    `/ocular-fee-queue`,
  );

  return appointment;
}

export async function submitOcularFeeProof(
  appointmentId: string,
  input: { referenceNumber: string; proofKey: string },
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only submit proof for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  if (appointment.ocularFeeStatus === 'proof_submitted') {
    throw AppError.badRequest('Proof has already been submitted. Please wait for cashier verification.');
  }

  appointment.ocularFeePaymentMethod = PaymentMethod.QRPH;
  appointment.ocularFeeReferenceNumber = input.referenceNumber;
  appointment.ocularFeeProofKey = input.proofKey;
  appointment.ocularFeeStatus = 'proof_submitted';
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { referenceNumber: input.referenceNumber, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashier role
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'New Ocular Fee Payment',
    `A customer has submitted ocular fee payment proof for appointment on ${appointment.date}.`,
    `/ocular-fee-queue`,
  );

  return appointment;
}

// ── Cashier: Verify Ocular Fee ──

export async function verifyOcularFee(
  appointmentId: string,
  cashierId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.ocularFeeStatus !== 'proof_submitted') {
    throw AppError.badRequest('No proof submitted to verify');
  }

  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeVerifiedBy = cashierId as unknown as Types.ObjectId;
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId: cashierId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId._id ?? appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Verified',
    `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been verified. Your assigned sales staff can now finalize your ocular visit.`,
    `/appointments/${appointment._id}`,
  );

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Ocular Fee Verified — Ready to Finalize',
      `Ocular fee for appointment on ${appointment.date} has been verified. You can now finalize this ocular visit.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Cashier: Decline Ocular Fee ──

export async function declineOcularFee(
  appointmentId: string,
  reason: string,
  cashierId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.ocularFeeStatus !== 'proof_submitted') {
    throw AppError.badRequest('No proof submitted to decline');
  }

  appointment.ocularFeeStatus = 'declined';
  appointment.ocularFeeDeclineReason = reason;
  appointment.ocularFeeProofKey = undefined;
  appointment.ocularFeeReferenceNumber = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_DECLINED,
    actorId: cashierId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Declined',
    `Your ocular fee payment was declined: ${reason}. Please re-submit a valid proof.`,
    `/appointments/${appointment._id}/pay-ocular-fee`,
  );

  return appointment;
}

// ── Cashier: List Pending Ocular Fees ──

export async function listPendingOcularFees() {
  const appointments = await Appointment.find({
    type: AppointmentType.OCULAR,
    'ocularFeeBreakdown.isWithinNCR': false,
    ocularFeeStatus: { $in: ['proof_submitted', 'pending', 'declined'] },
    status: { $ne: AppointmentStatus.CANCELLED },
  })
    .populate('customerId', 'firstName lastName email phone')
    .sort({ updatedAt: -1 });

  return appointments;
}

// ── Record Ocular Fee Payment (kept for agent/staff backward compat) ──

export async function recordOcularFee(
  appointmentId: string,
  input: RecordOcularFeeInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been recorded');
  }

  appointment.ocularFeePaymentMethod = input.paymentMethod;
  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeVerifiedBy = actorId as unknown as Types.ObjectId;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFeePaymentMethod: input.paymentMethod, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  return appointment;
}

// ── Set Ocular Fee (computed by maps module) ──

export async function setOcularFee(
  appointmentId: string,
  fee: number,
  breakdown: {
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
    total: number;
    isWithinNCR: boolean;
  },
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointment.ocularFee = fee;
  appointment.ocularFeeBreakdown = breakdown;
  await appointment.save();

  return appointment;
}

// ── Get Appointment by ID ──

export async function getAppointmentById(appointmentId: string, actorId: string, actorRoles: Role[]) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email phone')
    .populate('bookedBy', 'firstName lastName')
    .populate('confirmedBy', 'firstName lastName');

  if (!appointment) throw AppError.notFound('Appointment not found');

  // Customers can only view their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(r))
  ) {
    if (appointment.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
  }

  return appointment;
}

// ── List Appointments ──

export async function listAppointments(query: {
  status?: string;
  type?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  salesStaffId?: string;
  ocularFeeStatus?: string;
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
}, actorId: string, actorRoles: Role[]) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  // Role-based filtering
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(r))
  ) {
    filter.customerId = actorId;
  } else if (
    actorRoles.includes(Role.SALES_STAFF) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(r))
  ) {
    filter.salesStaffId = actorId;
  } else if (
    actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(r))
  ) {
    // Hide ocular appointments whose fee hasn't been paid yet, but always show office appointments
    filter.$or = [
      { type: { $ne: 'ocular' } },
      { type: 'ocular', ocularFeeStatus: { $ne: 'pending' } },
    ];
  }

  if (query.status) {
    if (query.status.includes(',')) {
      filter.status = { $in: query.status.split(',') };
    } else {
      filter.status = query.status;
    }
  }
  if (query.type) filter.type = query.type;
  if (query.date) filter.date = query.date;
  if (query.ocularFeeStatus) filter.ocularFeeStatus = query.ocularFeeStatus;
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;

  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) (filter.date as Record<string, string>).$gte = query.dateFrom;
    if (query.dateTo) (filter.date as Record<string, string>).$lte = query.dateTo;
  }

  if (query.search) {
    const searchRegex = { $regex: query.search, $options: 'i' };

    // Pre-lookup customer IDs matching the search term by name
    const matchingUsers = await User.find({
      $or: [{ firstName: searchRegex }, { lastName: searchRegex }],
    }).select('_id').lean();
    const matchingIds = matchingUsers.map((u) => u._id);

    const searchOr: Record<string, unknown>[] = [
      { customerNotes: searchRegex },
      { formattedAddress: searchRegex },
      { customerAddress: searchRegex },
    ];
    if (matchingIds.length > 0) searchOr.push({ customerId: { $in: matchingIds } });

    if (filter.$or) {
      // Role-based $or already set — move it into $and so both conditions hold
      const existingOr = filter.$or as Record<string, unknown>[];
      delete filter.$or;
      filter.$and = [{ $or: existingOr }, { $or: searchOr }];
    } else if (Object.keys(filter).length > 0) {
      filter.$and = [{ $or: searchOr }];
    } else {
      filter.$or = searchOr;
    }
  }

  const sortField = query.sortBy || 'date';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .populate('customerId', 'firstName lastName email phone')
      .populate('salesStaffId', 'firstName lastName')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit),
    Appointment.countDocuments(filter),
  ]);

  return {
    items: appointments,
    total,
    hasMore: page * limit < total,
  };
}













































// ── Auto-assign sales staff (round-robin based on least appointments for that date) ──

async function autoAssignSalesStaff(dateStr: string, slotCode: SlotCode): Promise<string> {
  // Get all active sales staff
  const salesStaff = await User.find({ roles: Role.SALES_STAFF, isActive: true });
  if (salesStaff.length === 0) {
    throw AppError.badRequest('No sales staff available');
  }

  // Filter out unavailable sales staff
  const unavail = await SalesAvailability.find({
    salesStaffId: { $in: salesStaff.map(s => s._id) },
    unavailableDates: dateStr,
  });
  const unavailableIds = new Set(unavail.map(u => u.salesStaffId.toString()));
  const available = salesStaff.filter(s => !unavailableIds.has(s._id.toString()));

  if (available.length === 0) {
    throw AppError.badRequest('No sales staff available on this date');
  }

  // Check who has the slot free (no existing lock)
  const locks = await SlotLock.find({
    date: dateStr,
    slotCode,
    salesId: { $in: available.map(s => s._id) },
    $or: [{ confirmed: true }, { expiresAt: { $gt: new Date() } }],
  });
  const lockedIds = new Set(locks.map(l => l.salesId.toString()));
  const freeStaff = available.filter(s => !lockedIds.has(s._id.toString()));

  if (freeStaff.length === 0) {
    throw AppError.conflict('No sales staff available for this slot', ErrorCode.SLOT_UNAVAILABLE);
  }

  // Pick the one with fewest appointments on this date
  const counts = await Promise.all(
    freeStaff.map(async (staff) => {
      const count = await Appointment.countDocuments({
        salesStaffId: staff._id,
        date: dateStr,
        status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.REQUESTED] },
      });
      return { staffId: staff._id.toString(), count };
    }),
  );

  counts.sort((a, b) => a.count - b.count);
  return counts[0].staffId;
}

