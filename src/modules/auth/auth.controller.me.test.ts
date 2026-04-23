import { describe, expect, it, vi } from 'vitest';

const {
  mockBuildAvailabilityStateSummary,
  mockGetOpenAvailabilitySession,
} = vi.hoisted(() => ({
  mockBuildAvailabilityStateSummary: vi.fn(),
  mockGetOpenAvailabilitySession: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    COOKIE_DOMAIN: '',
    COOKIE_SECURE: false,
    COOKIE_SAMESITE: 'lax',
  },
}));

vi.mock('../../middleware/csrf.js', () => ({
  generateCsrfToken: vi.fn(() => 'csrf-token'),
}));

vi.mock('../../utils/deviceInfo.js', () => ({
  extractClientHints: vi.fn(() => ({})),
}));

vi.mock('./auth.service.js', () => ({}));

vi.mock('../users/availability-session.service.js', () => ({
  buildAvailabilityStateSummary: mockBuildAvailabilityStateSummary,
  getOpenAvailabilitySession: mockGetOpenAvailabilitySession,
}));

import { me } from './auth.controller.js';
import { Role, StaffAvailabilityStatus } from '../../utils/constants.js';

describe('auth.controller me', () => {
  it('returns the availability summary fields used during app bootstrap', async () => {
    const user = {
      _id: 'user-1',
      email: 'sales@example.com',
      firstName: 'Sales',
      lastName: 'Staff',
      phone: '+639171234567',
      address: 'Muntinlupa',
      roles: [Role.SALES_STAFF],
      isEmailVerified: true,
      mustChangePassword: false,
      notificationPreferences: { appointment: true },
      twoFactorEnabled: false,
      provider: 'local',
      firebaseUid: undefined,
      photoURL: undefined,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    const session = { _id: 'session-1' };
    mockGetOpenAvailabilitySession.mockResolvedValueOnce(session);
    mockBuildAvailabilityStateSummary.mockReturnValueOnce({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilityNote: 'Morning shift',
      availabilityUpdatedAt: new Date('2026-04-23T00:30:00.000Z'),
      activeShift: {
        sessionId: 'session-1',
        shiftStartAt: new Date('2026-04-23T00:00:00.000Z'),
        shiftEndAt: new Date('2026-04-23T09:00:00.000Z'),
        isCurrent: true,
      },
      expiredShift: undefined,
      availabilitySetupRequired: false,
    });

    const res = {
      json: vi.fn(),
    };

    await new Promise<void>((resolve, reject) => {
      res.json.mockImplementationOnce(() => {
        resolve();
        return res;
      });

      me({ user } as never, res as never, reject);
    });

    expect(mockGetOpenAvailabilitySession).toHaveBeenCalledWith('user-1');
    expect(mockBuildAvailabilityStateSummary).toHaveBeenCalledWith(user, session);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        _id: 'user-1',
        availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
        availabilityNote: 'Morning shift',
        activeShift: expect.objectContaining({
          sessionId: 'session-1',
          isCurrent: true,
        }),
        expiredShift: undefined,
        availabilitySetupRequired: false,
      }),
    });
  });
});
