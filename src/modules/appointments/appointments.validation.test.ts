import { describe, expect, it } from 'vitest';
import { appointmentQueueQuerySchema } from './appointments.validation.js';

describe('appointmentQueueQuerySchema', () => {
  it('coerces numeric limit and keeps status/search filters', () => {
    const parsed = appointmentQueueQuerySchema.parse({
      status: 'requested,ready_for_ocular',
      search: 'garcia',
      limit: '50',
    });

    expect(parsed).toEqual({
      status: 'requested,ready_for_ocular',
      search: 'garcia',
      limit: 50,
    });
  });

  it('uses default limit when omitted', () => {
    const parsed = appointmentQueueQuerySchema.parse({});
    expect(parsed.limit).toBe(120);
  });

  it('rejects limits above max', () => {
    expect(() => appointmentQueueQuerySchema.parse({ limit: 201 })).toThrow();
  });
});
