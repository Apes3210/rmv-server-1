import { UAParser } from 'ua-parser-js';
import geoip from 'geoip-lite';

export interface ClientHints {
  /** e.g. "15.0.0" — major >= 13 means Windows 11 */
  uaPlatformVersion?: string;
  /** e.g. '"Chromium";v="124", "Brave";v="124"' */
  uaBrands?: string;
  /** e.g. "?0" (not mobile) or "?1" (mobile) */
  uaMobile?: string;
  /** e.g. "Windows" */
  uaPlatform?: string;
}

export interface DeviceInfo {
  browser: string;
  os: string;
  device: string; // 'desktop' | 'mobile' | 'tablet' | 'unknown'
  location: string;
}

/**
 * Extract a ClientHints object from Express req.headers (IncomingHttpHeaders).
 * Safe to call with any headers map — returns empty object if no hints present.
 */
export function extractClientHints(
  headers: Record<string, string | string[] | undefined>,
): ClientHints {
  const str = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  return {
    uaPlatformVersion: str(headers['sec-ch-ua-platform-version'])?.replace(/"/g, ''),
    uaBrands: str(headers['sec-ch-ua']),
    uaMobile: str(headers['sec-ch-ua-mobile']),
    uaPlatform: str(headers['sec-ch-ua-platform'])?.replace(/"/g, ''),
  };
}

export function parseDevice(
  userAgent?: string,
  ipAddress?: string,
  hints?: ClientHints,
): DeviceInfo {
  const result = UAParser(userAgent || '');
  const browser = result.browser;
  const os = result.os;
  const device = result.device;

  // ── Browser detection (Client-Hints aware) ──
  let browserName = browser.name || '';
  const browserMajor = browser.major || '';
  let resolvedBrowserStr: string | undefined;

  // Brave sends "Brave" in the Sec-CH-UA brands list but spoofs its UA as Chrome
  if (hints?.uaBrands && /brave/i.test(hints.uaBrands)) {
    // Extract Brave version from brands string: "Brave";v="125"
    const m = hints.uaBrands.match(/Brave";?\s*v="?(\d+)/i);
    browserName = 'Brave';
    const braveVersion = m?.[1] || browserMajor;
    resolvedBrowserStr = `Brave ${braveVersion}`;
  }

  const browserStr = resolvedBrowserStr ??
    (browserName
      ? `${browserName}${browserMajor ? ' ' + browserMajor : ''}`
      : 'Unknown Browser');

  // ── OS detection (Client-Hints aware) ──
  let osName = os.name || '';
  let osVersion = os.version || '';

  // Windows 10 vs 11: Chromium UA always says "Windows NT 10.0" for both.
  // Sec-CH-UA-Platform-Version major >= 13 → Windows 11.
  if (
    osName === 'Windows' &&
    hints?.uaPlatformVersion
  ) {
    const major = parseInt(hints.uaPlatformVersion.split('.')[0], 10);
    if (!isNaN(major)) {
      osVersion = major >= 13 ? '11' : '10';
    }
  }

  const osStr = osName
    ? `${osName}${osVersion ? ' ' + osVersion : ''}`
    : 'Unknown OS';

  const deviceType = device.type || 'desktop';

  let locationStr = 'Unknown';
  if (ipAddress) {
    // Strip ::ffff: prefix from IPv4-mapped IPv6
    const cleanIp = ipAddress.replace(/^::ffff:/, '');
    // Check if it's a private/localhost IP
    const isPrivate =
      cleanIp === '127.0.0.1' ||
      cleanIp === '::1' ||
      cleanIp.startsWith('192.168.') ||
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('172.');

    if (isPrivate) {
      locationStr = 'Local Network';
    } else {
      const geo = geoip.lookup(cleanIp);
      if (geo) {
        const parts: string[] = [];
        if (geo.city) parts.push(geo.city);
        if (geo.country) parts.push(geo.country);
        locationStr = parts.length > 0 ? parts.join(', ') : 'Unknown';
      }
    }
  }

  return {
    browser: browserStr,
    os: osStr,
    device: deviceType,
    location: locationStr,
  };
}
