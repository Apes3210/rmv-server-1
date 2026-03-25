import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockRefundFindById,
  mockAuditCreate,
} = vi.hoisted(() => ({
  mockRefundFindById: vi.fn(),
  mockAuditCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {},
  RefundRequest: {
    findById: mockRefundFindById,
  },
  AuditLog: {
    create: mockAuditCreate,
  },
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: vi.fn(),
  emitRoleEvent: vi.fn(),
}));

import { dispatchRefundRequest, reconcileRefundRequest } from './refunds.service.js';
import { AuditAction, RefundRequestStatus } from '../../utils/constants.js';
import { ErrorCode } from '../../utils/appError.js';

function buildRefund(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'refund-1',
    status: RefundRequestStatus.APPROVED,
    amount: 250,
    dispatchTrail: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('refunds.service dispatch/reconcile trails', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches approved refund and writes dispatch audit/trail', async () => {
    const refund = buildRefund();
    mockRefundFindById.mockResolvedValueOnce(refund);

    const result = await dispatchRefundRequest(
      'refund-1',
      {
        referenceNumber: 'REF-2026-001',
        note: 'Sent to GCash',
      },
      'cashier-1',
      '127.0.0.1',
      'vitest',
    );

    expect(result.dispatchReferenceNumber).toBe('REF-2026-001');
    expect(result.dispatchTrail).toHaveLength(1);
    expect(result.dispatchTrail[0]).toMatchObject({
      event: 'dispatched',
      actorId: 'cashier-1',
      referenceNumber: 'REF-2026-001',
    });
    expect(result.save).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.REFUND_DISPATCHED,
      actorId: 'cashier-1',
      targetType: 'refund_request',
    }));
  });

  it('blocks dispatch when refund is not approved', async () => {
    mockRefundFindById.mockResolvedValueOnce(buildRefund({
      status: RefundRequestStatus.PENDING,
    }));

    await expect(
      dispatchRefundRequest('refund-1', { referenceNumber: 'REF-FAIL' }, 'cashier-1'),
    ).rejects.toMatchObject({
      code: ErrorCode.REFUND_NOT_ALLOWED,
    });
  });

  it('reconciles dispatched refund and records trail/audit', async () => {
    const refund = buildRefund({
      dispatchedAt: new Date('2026-03-17T00:00:00.000Z'),
      dispatchReferenceNumber: 'REF-2026-001',
    });
    mockRefundFindById.mockResolvedValueOnce(refund);

    const result = await reconcileRefundRequest(
      'refund-1',
      {
        note: 'Matched against ledger',
      },
      'cashier-1',
    );

    expect(result.reconciledAt).toBeInstanceOf(Date);
    expect(result.dispatchTrail).toHaveLength(1);
    expect(result.dispatchTrail[0]).toMatchObject({
      event: 'reconciled',
      referenceNumber: 'REF-2026-001',
      actorId: 'cashier-1',
    });
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.REFUND_RECONCILED,
    }));
  });

  it('blocks reconciliation before dispatch', async () => {
    mockRefundFindById.mockResolvedValueOnce(buildRefund({ dispatchedAt: undefined }));

    await expect(
      reconcileRefundRequest('refund-1', { note: 'should-fail' }, 'cashier-1'),
    ).rejects.toMatchObject({
      code: ErrorCode.REFUND_NOT_ALLOWED,
    });
  });
});
