// functions/src/badge-svg.ts

/**
 * Approximate character width for Inter/system-ui at 11px.
 * Measured from common badge text — good enough for SVG layout.
 */
const CHAR_WIDTH = 6.6;
const PADDING_H = 12;
const HEIGHT = 24;
const RADIUS = 6;
const FONT = 'Inter,system-ui,sans-serif';

// Branding footer bar
const FOOTER_GAP = 2;
const FOOTER_H = 14;
const FOOTER_R = 4;
const FOOTER_Y = HEIGHT + FOOTER_GAP;
const BRAND_TEXT = 'exit1.dev';
const BRAND_FONT_SIZE = 9;
const BRAND_CHAR_WIDTH = 5.4;

function measureText(text: string): number {
  return Math.ceil(text.length * CHAR_WIDTH);
}

function measureBrandText(text: string): number {
  return Math.ceil(text.length * BRAND_CHAR_WIDTH);
}

type BadgeColors = {
  top: string;
  bottom: string;
};

export function renderBadge(
  label: string,
  value: string,
  valueColors: BadgeColors,
  branding = true
): string {
  const labelWidth = measureText(label) + PADDING_H * 2;
  const valueWidth = measureText(value) + PADDING_H * 2;
  const totalWidth = labelWidth + valueWidth;

  const labelColors: BadgeColors = { top: '#3f3f46', bottom: '#27272a' };

  const R = RADIUS;
  const H = HEIGHT;

  // Label path: rounded left corners, square right corners
  const labelPath = `M${R},0 H${labelWidth} V${H} H${R} A${R},${R},0,0,1,0,${H - R} V${R} A${R},${R},0,0,1,${R},0Z`;
  // Value path: square left corners, rounded right corners
  const valuePath = `M0,0 H${valueWidth - R} A${R},${R},0,0,1,${valueWidth},${R} V${H - R} A${R},${R},0,0,1,${valueWidth - R},${H} H0Z`;

  const badgeCore = `<path d="${labelPath}" fill="url(#lg)"/>
  <g transform="translate(${labelWidth},0)"><path d="${valuePath}" fill="url(#vg)"/></g>
  <text x="${labelWidth / 2}" y="${H / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${labelWidth + valueWidth / 2}" y="${H / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>`;

  if (!branding) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${H}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
  </defs>
  ${badgeCore}
</svg>`;
  }

  // Branded: badge + footer bar
  const totalH = FOOTER_Y + FOOTER_H;
  const brandColors: BadgeColors = { top: '#27272a', bottom: '#18181b' };

  // Center icon + text in footer
  const brandTextW = measureBrandText(BRAND_TEXT);
  const iconW = 9;
  const iconGap = 3;
  const contentW = iconW + iconGap + brandTextW;
  const contentX = (totalWidth - contentW) / 2;
  const textCenterX = contentX + iconW + iconGap + brandTextW / 2;
  const footerCenterY = FOOTER_Y + FOOTER_H / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalH}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${brandColors.top}"/><stop offset="1" stop-color="${brandColors.bottom}"/></linearGradient>
  </defs>
  ${badgeCore}
  <rect x="0" y="${FOOTER_Y}" width="${totalWidth}" height="${FOOTER_H}" rx="${FOOTER_R}" fill="url(#bg)"/>
  <g transform="translate(${contentX},${footerCenterY - 4})">
    <path d="M1,0 V8 M1,0 H3.5 M1,8 H3.5" stroke="#52525b" stroke-width="1.1" stroke-linecap="round"/>
    <path d="M4,4 H8 M6.5,2 L8,4 L6.5,6" stroke="#22c55e" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="${textCenterX}" y="${footerCenterY + 3}" fill="#71717a" font-family="${FONT}" font-size="${BRAND_FONT_SIZE}" font-weight="500" text-anchor="middle">${escapeXml(BRAND_TEXT)}</text>
</svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const COLORS = {
  green: { top: '#22c55e', bottom: '#16a34a' },
  red: { top: '#ef4444', bottom: '#dc2626' },
  amber: { top: '#f59e0b', bottom: '#d97706' },
  blue: { top: '#3b82f6', bottom: '#2563eb' },
  gray: { top: '#71717a', bottom: '#52525b' },
} as const;

export type BadgeType = 'status' | 'uptime' | 'response';

export interface BadgeData {
  name: string;
  status: 'online' | 'offline' | 'unknown';
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  maintenanceMode?: boolean;
  disabled?: boolean;
  responseTime?: number;
  uptimePercentage?: number;
}

export function renderStatusBadge(data: BadgeData, branding = true): string {
  const label = data.name;
  if (data.disabled) return renderBadge(label, 'paused', COLORS.gray, branding);
  if (data.maintenanceMode) return renderBadge(label, 'maintenance', COLORS.amber, branding);
  if (data.status === 'online') return renderBadge(label, 'online', COLORS.green, branding);
  if (data.status === 'offline') return renderBadge(label, 'offline', COLORS.red, branding);
  return renderBadge(label, 'unknown', COLORS.gray, branding);
}

export function renderUptimeBadge(data: BadgeData, branding = true): string {
  const label = data.name;
  const pct = data.uptimePercentage;
  if (pct == null) return renderBadge(label, 'N/A', COLORS.gray, branding);
  const display = pct >= 99.95 ? '100%' : `${pct.toFixed(1)}%`;
  const color = pct >= 99 ? COLORS.green : pct >= 95 ? COLORS.amber : COLORS.red;
  return renderBadge(label, display, color, branding);
}

export function renderResponseBadge(data: BadgeData, branding = true): string {
  const label = data.name;
  const ms = data.responseTime;
  if (ms == null) return renderBadge(label, 'N/A', COLORS.gray, branding);
  return renderBadge(label, `${Math.round(ms)}ms`, COLORS.blue, branding);
}

export function renderBadgeSvg(type: BadgeType, data: BadgeData, branding = true): string {
  switch (type) {
    case 'status': return renderStatusBadge(data, branding);
    case 'uptime': return renderUptimeBadge(data, branding);
    case 'response': return renderResponseBadge(data, branding);
  }
}
