import { Router } from 'express';
import * as ctrl from './visit-reports.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createVisitReportSchema,
  updateVisitReportSchema,
  returnVisitReportSchema,
  reopenVisitReportSchema,
} from './visit-reports.validation.js';

const router = Router();

// ── List (role-filtered in controller) ──
router.get(
  '/',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.listVisitReports,
);

// ── Create (Sales Staff adds another project/report to an appointment) ──
router.post(
  '/',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(createVisitReportSchema),
  ctrl.createVisitReport,
);

// ── Get by appointment (returns array) ──
router.get(
  '/appointment/:appointmentId',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN, Role.APPOINTMENT_AGENT),
  ctrl.getByAppointment,
);

// ── Get by ID ──
router.get(
  '/:id',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.getVisitReport,
);

// ── Update (Sales Staff fills draft/returned) ──
router.put(
  '/:id',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(updateVisitReportSchema),
  ctrl.updateVisitReport,
);

// ── Delete (Sales Staff removes accidental extra draft/returned report) ──
router.delete(
  '/:id',
  authenticate,
  authorize(Role.SALES_STAFF),
  ctrl.deleteVisitReport,
);

// ── Submit to Engineer ──
router.post(
  '/:id/submit',
  authenticate,
  authorize(Role.SALES_STAFF),
  ctrl.submitVisitReport,
);

// ── Return (Engineer/Admin) ──
router.post(
  '/:id/return',
  authenticate,
  authorize(Role.ENGINEER, Role.ADMIN),
  validate(returnVisitReportSchema),
  ctrl.returnVisitReport,
);

router.post(
  '/:id/reopen-for-repair',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(reopenVisitReportSchema),
  ctrl.reopenVisitReportForRepair,
);

export default router;
