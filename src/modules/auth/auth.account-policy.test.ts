import { describe, expect, it } from 'vitest';
import { hasLocalPassword, isGoogleOnlyAccount, isInternalManagedAccount } from './auth.account-policy.js';

describe('auth account policy', () => {
  it('treats a Google account without a password as Google-only', () => {
    expect(
      isGoogleOnlyAccount({
        provider: 'google',
        firebaseUid: 'firebase-123',
        password: undefined,
      }),
    ).toBe(true);
  });

  it('treats a Google-linked account with a password as not Google-only', () => {
    expect(
      isGoogleOnlyAccount({
        provider: 'google',
        firebaseUid: 'firebase-123',
        password: 'hashed-password',
      }),
    ).toBe(false);
  });

  it('treats a local account with a password as having local login available', () => {
    expect(
      hasLocalPassword({
        provider: 'local',
        password: 'hashed-password',
      }),
    ).toBe(true);
  });

  it('treats a linked local account without a password as not having local login', () => {
    expect(
      hasLocalPassword({
        provider: 'local',
        firebaseUid: 'firebase-123',
        password: undefined,
      }),
    ).toBe(false);
  });

  it('treats an internal staff role as admin-managed', () => {
    expect(
      isInternalManagedAccount({
        roles: ['engineer'],
      }),
    ).toBe(true);
  });

  it('does not treat customer accounts as admin-managed internal accounts', () => {
    expect(
      isInternalManagedAccount({
        roles: ['customer'],
      }),
    ).toBe(false);
  });
});