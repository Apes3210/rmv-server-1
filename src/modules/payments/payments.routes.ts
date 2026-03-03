import { Router } from 'express';
import * as ctrl from './payments.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createPaymentPlanSchema,
  updatePaymentPlanSchema,
  submitPaymentProofSchema,
  verifyPaymentSchema,
  declinePaymentSchema,
  recordCashPaymentSchema,
} from './payments.validation.js';

const router = Router();

// ── Cashier: Payment Plan ──
router.post(
  '/plans',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(createPaymentPlanSchema),
  ctrl.createPaymentPlan,
);

router.patch(
  '/plans/:id',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(updatePaymentPlanSchema),
  ctrl.updatePaymentPlan,
);

// ── Customer: Submit Proof ──
router.post(
  '/submit-proof',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitPaymentProofSchema),
  ctrl.submitPaymentProof,
);

// ── Customer: Create QRPH Checkout ──
router.post(
  '/stages/:stageId/checkout',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.createStageCheckout,
);

// ⚠️ DEV ONLY: Simulate Stage Payment ──
router.post(
  '/stages/:stageId/simulate',
  authenticate,
  ctrl.simulateStagePayment,
);

// ── Cashier: Record Cash Payment ──
router.post(
  '/record-cash',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(recordCashPaymentSchema),
  ctrl.recordCashPayment,
);

// ── Cashier: Verify / Decline ──
router.post(
  '/:id/verify',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.verifyPayment,
);

router.post(
  '/:id/decline',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(declinePaymentSchema),
  ctrl.declinePayment,
);

// ── Customer: Payment History ──
router.get(
  '/my-history',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.getMyPaymentHistory,
);

// ── Cashier: Pending Queue ──
router.get(
  '/pending',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listPendingPayments,
);

// ── Cashier: Overdue Payments Queue ──
router.get(
  '/overdue',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listOverduePayments,
);

// ── Read ──
router.get(
  '/plan/:projectId',
  authenticate,
  ctrl.getPaymentPlanByProject,
);

router.get(
  '/project/:projectId',
  authenticate,
  ctrl.listPaymentsByProject,
);

router.get(
  '/:id',
  authenticate,
  ctrl.getPaymentById,
);

router.get(
  '/:id/receipt-url',
  authenticate,
  ctrl.getReceiptDownloadUrl,
);

export default router;
