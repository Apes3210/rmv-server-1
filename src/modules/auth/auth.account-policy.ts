type AuthAccountLike = {
  password?: string | null;
  provider?: 'local' | 'google' | null;
  firebaseUid?: string | null;
  roles?: string[] | null;
};

const INTERNAL_ROLES = new Set([
  'appointment_agent',
  'sales_staff',
  'engineer',
  'cashier',
  'admin',
  'fabrication_staff',
]);

export function hasLocalPassword(account: AuthAccountLike | null | undefined): boolean {
  return typeof account?.password === 'string' && account.password.length > 0;
}

export function isGoogleOnlyAccount(account: AuthAccountLike | null | undefined): boolean {
  return account?.provider === 'google' && Boolean(account?.firebaseUid) && !hasLocalPassword(account);
}

export function isInternalManagedAccount(account: AuthAccountLike | null | undefined): boolean {
  return Array.isArray(account?.roles) && account.roles.some((role) => INTERNAL_ROLES.has(role));
}
