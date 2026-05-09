import crypto from 'crypto';
import { AppError, ErrorCode } from './appError.js';

export interface UserAddressInput {
  id?: string;
  label?: string;
  street?: string;
  barangay?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  addressType?: 'personal' | 'business';
  lat?: number;
  lng?: number;
  formattedAddress?: string;
  isDefault?: boolean;
}

function clean(value?: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasPinnedAddress(address?: UserAddressInput | null) {
  return Boolean(
    address
    && clean(address.city)
    && clean(address.formattedAddress)
    && typeof address.lat === 'number'
    && typeof address.lng === 'number',
  );
}

export function requirePinnedAddress(address?: UserAddressInput | null) {
  if (!hasPinnedAddress(address)) {
    throw AppError.badRequest(
      'A saved address with city, formatted address, and map pin is required.',
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

export function normalizeUserAddress(address: UserAddressInput, fallbackLabel = 'Primary address'): UserAddressInput {
  const normalized: UserAddressInput = {
    id: clean(address.id) || crypto.randomUUID(),
    label: clean(address.label) || fallbackLabel,
    street: clean(address.street),
    barangay: clean(address.barangay),
    city: clean(address.city),
    province: clean(address.province),
    zip: clean(address.zip),
    country: clean(address.country) || 'Philippines',
    addressType: address.addressType || 'business',
    formattedAddress: clean(address.formattedAddress),
    isDefault: Boolean(address.isDefault),
  };

  if (typeof address.lat === 'number') normalized.lat = address.lat;
  if (typeof address.lng === 'number') normalized.lng = address.lng;

  return normalized;
}

export function normalizeSavedAddresses(input?: UserAddressInput[], legacyAddress?: UserAddressInput | null) {
  const source = input?.length ? input : legacyAddress ? [legacyAddress] : [];
  const normalized = source
    .filter((address) => hasPinnedAddress(address))
    .map((address, index) => normalizeUserAddress(address, index === 0 ? 'Primary address' : `Address ${index + 1}`));

  if (normalized.length === 0) return [];

  const defaultIndex = normalized.findIndex((address) => address.isDefault);
  normalized.forEach((address, index) => {
    address.isDefault = defaultIndex >= 0 ? index === defaultIndex : index === 0;
  });

  return normalized;
}

export function getDefaultSavedAddress(savedAddresses?: UserAddressInput[], legacyAddress?: UserAddressInput | null) {
  const normalized = normalizeSavedAddresses(savedAddresses, legacyAddress);
  return normalized.find((address) => address.isDefault) || normalized[0];
}
