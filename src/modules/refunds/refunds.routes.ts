import { Router } from 'express';
import * as ctrl from './refunds.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  submitRefundRequestSchema,
  denyRefundRequestSchema,
  updateMyRefundRequestSchema,
  cancelMyRefundRequestSchema,
  dispatchRefundRequestSchema,
  reconcileRefundRequestSchema,
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

router.patch(
  '/:id/my',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(updateMyRefundRequestSchema),
  ctrl.updateMyRefundRequest,
);

router.post(
  '/:id/my/cancel',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(cancelMyRefundRequestSchema),
  ctrl.cancelMyRefundRequest,
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

router.post(
  '/:id/dispatch',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(dispatchRefundRequestSchema),
  ctrl.dispatchRefundRequest,
);

router.post(
  '/:id/reconcile',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(reconcileRefundRequestSchema),
  ctrl.reconcileRefundRequest,
);

export default router;
