import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils/appError.js';
import { logger } from '../utils/logger.js';
import { AuditLog } from '../models/index.js';
import { AuditAction } from '../utils/constants.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function pickTargetId(req: Request): string | undefined {
  const candidateKeys = ['id', 'projectId', 'appointmentId', 'paymentId', 'blueprintId', 'reportId', 'userId'];
  for (const key of candidateKeys) {
    const value = req.params?.[key];
    if (typeof value === 'string' && OBJECT_ID_RE.test(value)) {
      return value;
    }
  }
  return undefined;
}

function inferTargetType(req: Request): string {
  const path = req.baseUrl || req.path || req.originalUrl || '';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return 'unknown';
  return segments[0] === 'api' ? (segments[1] || 'unknown') : segments[0];
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // AppError (operational)
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational AppError:', {
        message: err.message,
        code: err.code,
        stack: err.stack,
      });
    }

    if (err.code === ErrorCode.INVALID_TRANSITION) {
      const targetId = pickTargetId(req);
      void AuditLog.create({
        action: AuditAction.LIFECYCLE_MISMATCH_BLOCKED,
        actorId: req.user?._id,
        actorEmail: req.user?.email,
        targetType: inferTargetType(req),
        targetId,
        details: {
          errorCode: err.code,
          diagnosticsType: err.details?.diagnosticsType,
          refreshRequired: err.details?.refreshRequired,
          currentStatus: err.details?.currentStatus,
          attemptedStatus: err.details?.attemptedStatus,
          allowedNextStatuses: err.details?.allowedNextStatuses,
          method: req.method,
          path: req.originalUrl,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || req.headers['user-agent'],
      }).catch((auditError) => {
        logger.error('Failed to write lifecycle mismatch audit log', {
          message: auditError instanceof Error ? auditError.message : String(auditError),
          path: req.originalUrl,
        });
      });
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation error',
        details: err.message,
      },
    });
    return;
  }

  // Mongoose duplicate key
  if (err.name === 'MongoServerError' && (err as unknown as { code: number }).code === 11000) {
    res.status(409).json({
      success: false,
      error: {
        code: ErrorCode.DUPLICATE_ENTRY,
        message: 'Duplicate entry',
      },
    });
    return;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid ID format',
      },
    });
    return;
  }

  // Unknown error
  logger.error('Unhandled error:', {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    },
  });
};
