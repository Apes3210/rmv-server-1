import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockAuditCreate, mockLoggerError } = vi.hoisted(() => ({
  mockAuditCreate: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../models/index.js', () => ({
  AuditLog: {
    create: mockAuditCreate,
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    error: mockLoggerError,
  },
}));

import { errorHandler } from './errorHandler.js';
import { AppError, ErrorCode } from '../utils/appError.js';
import { AuditAction } from '../utils/constants.js';

function createResponseMock() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  return res;
}

describe('errorHandler lifecycle mismatch auditing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a lifecycle mismatch audit log for INVALID_TRANSITION errors', async () => {
    mockAuditCreate.mockResolvedValue({});

    const err = AppError.badRequest(
      'Invalid status transition: approved -> fabrication',
      ErrorCode.INVALID_TRANSITION,
      {
        diagnosticsType: 'LIFECYCLE_MISMATCH',
        refreshRequired: true,
        currentStatus: 'approved',
        attemptedStatus: 'fabrication',
        allowedNextStatuses: ['payment_pending'],
      },
    );

    const req = {
      method: 'POST',
      originalUrl: '/api/projects/660000000000000000000001/status',
      baseUrl: '/api/projects',
      path: '/status',
      params: { projectId: '660000000000000000000001' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'vitest-agent' },
      get: vi.fn().mockReturnValue('vitest-agent'),
      user: {
        _id: '650000000000000000000010',
        email: 'admin@example.com',
      },
    } as unknown as Request;

    const res = createResponseMock();

    errorHandler(err, req, res, vi.fn());

    await Promise.resolve();

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.LIFECYCLE_MISMATCH_BLOCKED,
        actorEmail: 'admin@example.com',
        targetType: 'projects',
        targetId: '660000000000000000000001',
        details: expect.objectContaining({
          errorCode: ErrorCode.INVALID_TRANSITION,
          diagnosticsType: 'LIFECYCLE_MISMATCH',
          refreshRequired: true,
          currentStatus: 'approved',
          attemptedStatus: 'fabrication',
        }),
      }),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: ErrorCode.INVALID_TRANSITION,
        }),
      }),
    );
  });

  it('does not create lifecycle mismatch audit log for non-transition AppErrors', () => {
    mockAuditCreate.mockResolvedValue({});

    const err = AppError.badRequest(
      'Invalid payload',
      ErrorCode.VALIDATION_ERROR,
    );

    const req = {
      method: 'POST',
      originalUrl: '/api/projects',
      baseUrl: '/api/projects',
      path: '/',
      params: {},
      headers: {},
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Request;

    const res = createResponseMock();

    errorHandler(err, req, res, vi.fn());

    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
