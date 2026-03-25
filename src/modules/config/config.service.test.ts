import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfigFindOne,
  mockAuditCreate,
} = vi.hoisted(() => ({
  mockConfigFindOne: vi.fn(),
  mockAuditCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Config: {
    findOne: mockConfigFindOne,
  },
  Holiday: {},
  BlockedSlot: {},
  AuditLog: {
    create: mockAuditCreate,
  },
}));

import {
  listConfigVersions,
  previewConfigImpact,
  rollbackConfigVersion,
} from './config.service.js';
import { AuditAction } from '../../utils/constants.js';
import { ErrorCode } from '../../utils/appError.js';

function buildVersion(id: string, value: unknown, iso: string) {
  return {
    _id: {
      toString: () => id,
    },
    value,
    description: `version-${id}`,
    updatedBy: 'admin-1',
    updatedAt: new Date(iso),
  };
}

describe('config.service phase3 safeguards', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns high-risk preview with warnings for risky config edits', async () => {
    const result = await previewConfigImpact('installment_split', [60, 20]);

    expect(result).toMatchObject({
      key: 'installment_split',
      riskLevel: 'medium',
      requiresConfirmation: true,
    });
    expect(result.warnings.some((w) => w.includes('Installment split should total 100'))).toBe(true);
  });

  it('sorts config versions by updatedAt descending and applies limit', async () => {
    mockConfigFindOne.mockResolvedValueOnce({
      value: 'current',
      description: 'current-desc',
      updatedAt: new Date('2026-03-17T00:00:00.000Z'),
      updatedBy: 'admin-current',
      versions: [
        buildVersion('v1', 'old-1', '2026-03-01T00:00:00.000Z'),
        buildVersion('v2', 'old-2', '2026-03-10T00:00:00.000Z'),
        buildVersion('v3', 'old-3', '2026-03-05T00:00:00.000Z'),
      ],
    });

    const result = await listConfigVersions('payment_activation_map', 2);

    expect(result.versions).toHaveLength(2);
    expect(result.versions[0]?._id.toString()).toBe('v2');
    expect(result.versions[1]?._id.toString()).toBe('v3');
  });

  it('rolls back to selected version and writes rollback audit', async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    mockConfigFindOne.mockResolvedValueOnce({
      _id: 'cfg-1',
      value: 'current',
      description: 'current-desc',
      updatedBy: 'admin-current',
      updatedAt: new Date('2026-03-17T00:00:00.000Z'),
      versions: [
        buildVersion('v1', 'old-1', '2026-03-10T00:00:00.000Z'),
      ],
      save,
    });

    const result = await rollbackConfigVersion(
      'maintenance_mode',
      { versionId: 'v1' },
      'admin-rollback',
      '127.0.0.1',
      'vitest',
    );

    expect(result.value).toBe('old-1');
    expect(save).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.CONFIG_ROLLED_BACK,
      actorId: 'admin-rollback',
      targetType: 'config',
      details: expect.objectContaining({
        key: 'maintenance_mode',
        rolledBackToVersionId: 'v1',
      }),
    }));
  });

  it('throws when rollback version does not exist', async () => {
    mockConfigFindOne.mockResolvedValueOnce({
      versions: [],
    });

    await expect(
      rollbackConfigVersion('maintenance_mode', { versionId: 'missing' }, 'admin-1'),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
