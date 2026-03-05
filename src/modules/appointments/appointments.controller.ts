import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as appointmentsService from './appointments.service.js';
import { AppointmentStatus, Role } from '../../utils/constants.js';

/** Map populated appointment to the shape the frontend expects */
function formatAppointment(appt: any) {
  const obj = appt.toObject ? appt.toObject() : { ...appt };
  const cust = obj.customerId && typeof obj.customerId === 'object' ? obj.customerId : null;
  const sales = obj.salesStaffId && typeof obj.salesStaffId === 'object' ? obj.salesStaffId : null;
  const location = obj.customerLocation || (
    typeof obj.latitude === 'number' && typeof obj.longitude === 'number'
      ? { lat: obj.latitude, lng: obj.longitude }
      : undefined
  );
  return {
    ...obj,
    customerId: cust?._id?.toString() || obj.customerId,
    customerName: cust ? `${cust.firstName} ${cust.lastName}` : undefined,
    salesStaffId: sales?._id?.toString() || obj.salesStaffId || undefined,
    salesStaffName: sales ? `${sales.firstName} ${sales.lastName}` : undefined,
    address: obj.formattedAddress || obj.customerAddress,
    formattedAddress: obj.formattedAddress || obj.customerAddress,
    latitude: location?.lat,
    longitude: location?.lng,
    location,
    purpose: obj.customerNotes,
  };
}

// ── Get Available Slots ──
export const getAvailableSlots = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.getAvailableSlots(req.query as any);
  res.json({ success: true, data: result });
});

// ── Customer: Request Appointment ──
export const requestAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.requestAppointment(
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Agent: Create on behalf of customer ──
export const agentCreateAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentCreateAppointment(
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Confirm ──
export const confirmAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.confirmAppointment(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Complete ──
export const completeAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.completeAppointment(
    (req.params.id as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Update Visit Status (Preparing / On The Way) ──
export const updateVisitStatus = asyncHandler(async (req: Request, res: Response) => {
  const newStatus = req.params.status as AppointmentStatus.PREPARING | AppointmentStatus.ON_THE_WAY;
  const appointment = await appointmentsService.updateVisitStatus(
    req.params.id as string,
    newStatus,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── No Show ──
export const markNoShow = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.markNoShow(
    (req.params.id as string),
    req.body.internalNotes,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Customer: Request Reschedule ──
export const requestReschedule = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.requestReschedule(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Agent: Complete Reschedule ──
export const completeReschedule = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.completeReschedule(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cancel ──
export const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
  const primaryRole = req.userRoles!.includes(Role.CUSTOMER) ? Role.CUSTOMER : req.userRoles![0];
  const appointment = await appointmentsService.cancelAppointment(
    (req.params.id as string),
    req.body.reason,
    req.userId!,
    primaryRole,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Record Ocular Fee ──
export const recordOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.recordOcularFee(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ⚠️ TESTING ONLY: Simulate ocular fee payment. Remove for production.
export const simulateOcularFeePayment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.simulateOcularFeePayment(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: { verified: true, appointmentId: appointment._id } });
});
// ⚠️ END TESTING ONLY

// ── Customer: Verify Ocular Fee Checkout via PayMongo API ──
export const verifyOcularFeeCheckout = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.verifyOcularFeeCheckout(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: { verified: result.verified, appointment: result.appointment } });
});

// ── Customer: Create PayMongo Checkout for Ocular Fee ──
export const createOcularFeeCheckout = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.createOcularFeeCheckout(
    (req.params.id as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({
    success: true,
    data: {
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
    },
  });
});

// ── Customer: Submit Ocular Fee Proof (manual fallback) ──
export const submitOcularFeeProof = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.submitOcularFeeProof(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: Verify Ocular Fee ──
export const verifyOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.verifyOcularFee(
    (req.params.id as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: Decline Ocular Fee ──
export const declineOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.declineOcularFee(
    (req.params.id as string),
    req.body.reason,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: List Pending Ocular Fees ──
export const listPendingOcularFees = asyncHandler(async (_req: Request, res: Response) => {
  const appointments = await appointmentsService.listPendingOcularFees();
  res.json({ success: true, data: appointments.map(formatAppointment) });
});

// ── Admin: Refund Ocular Fee ──
export const refundOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.refundOcularFee(
    req.params.id as string,
    req.body.reason,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Get By ID ──
export const getAppointmentById = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.getAppointmentById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Customer: Submit Site Details ──
export const submitSiteDetails = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.submitSiteDetails(
    req.params.id as string,
    req.body,
    req.userId!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Customer: Skip Site Details (ocular only) ──
export const skipSiteDetails = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.skipSiteDetails(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── List ──
export const listAppointments = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.listAppointments(
    req.query as any,
    req.userId!,
    req.userRoles!,
  );
  res.json({
    success: true,
    data: {
      ...result,
      items: result.items.map(formatAppointment),
    },
  });
});

// ── Agent: Create Ocular (from consultation context) ──
export const agentCreateOcular = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentCreateOcular(
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Customer: Submit Ocular Location ──
export const customerSubmitOcularLocation = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.customerSubmitOcularLocation(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Agent: Finalize Ocular ──
export const agentFinalizeOcular = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentFinalizeOcular(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});
