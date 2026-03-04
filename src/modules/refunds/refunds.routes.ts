import { Router } from 'express';
import * as ctrl from './refunds.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  submitRefundRequestSchema,
  denyRefundRequestSchema,
} from './refunds.validation.js';

const router = Router();

// ── Customer: Submit Refund Request ──
router.post(
  '/',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitRefundRequestSchema),
  ctrl.submitRefundRequest,
);

// ── Customer: List own refund requests ──
router.get(
  '/my',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.listMyRefundRequests,
);

// ── Cashier/Admin: List all refund requests ──
router.get(
  '/',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listRefundRequests,
);

// ── Cashier/Admin: Approve ──
router.post(
  '/:id/approve',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.approveRefundRequest,
);

// ── Cashier/Admin: Deny ──
router.post(
  '/:id/deny',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(denyRefundRequestSchema),
  ctrl.denyRefundRequest,
);

export default router;
