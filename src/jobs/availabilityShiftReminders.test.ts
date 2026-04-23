import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailabilitySessionFind,
  mockCreateAndSendNotification,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockAvailabilitySessionFind: vi.fn(),
  mockCreateAndSendNotification: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../models/index.js', () => ({
  AvailabilitySession: {
    find: mockAvailabilitySessionFind,
  },
}));

vi.mock('../modules/notifications/socket.service.js', () => ({
  createAndSendNotification: mockCreateAndSendNotification,
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    error: mockLoggerError,
  },
}));

import { processAvailabilityShiftReminders } from './availabilityShiftReminders.js';
import { NotificationCategory } from '../utils/constants.js';

function mockSelectable<T>(value: T) {
  return {
    select: vi.fn().mockResolvedValue(value),
  };
}

describe('processAvailabilityShiftReminders', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a one-time notification and stamps reminderSentAt for expired open shifts', async () => {
    const now = new Date('2026-04-23T10:00:00.000Z');
    const session = {
      _id: {
        toString: () => 'session-1',
      },
      userId: 'user-1',
      shiftEndAt: new Date('2026-04-23T09:00:00.000Z'),
      reminderSentAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockAvailabilitySessionFind.mockReturnValueOnce(mockSelectable([session]));

    await processAvailabilityShiftReminders(now);

    expect(mockCreateAndSendNotification).toHaveBeenCalledWith(
      'user-1',
      NotificationCategory.SYSTEM,
      'Shift Ended',
      expect.stringContaining('Please close your availability when you are done.'),
      '/account/profile',
    );
    expect(session.reminderSentAt).toBe(now);
    expect(session.save).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
