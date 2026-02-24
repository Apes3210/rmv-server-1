import { UAParser } from 'ua-parser-js';
import geoip from 'geoip-lite';

export interface DeviceInfo {
  browser: string;
  os: string;
  device: string; // 'desktop' | 'mobile' | 'tablet' | 'unknown'
  location: string;
}

export function parseDevice(userAgent?: string, ipAddress?: string): DeviceInfo {
  const result = UAParser(userAgent || '');
  const browser = result.browser;
  const os = result.os;
  const device = result.device;

  const browserStr = browser.name
    ? `${browser.name}${browser.major ? ' ' + browser.major : ''}`
    : 'Unknown Browser';

  const osStr = os.name
    ? `${os.name}${os.version ? ' ' + os.version : ''}`
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
