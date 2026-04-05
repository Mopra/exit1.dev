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

// Branding segment layout
const BRAND_TEXT = 'exit1.dev';
const BRAND_PAD = 8;
const BRAND_ICON_W = 10;
const BRAND_ICON_GAP = 3;
const BRAND_FONT_SIZE = 10;
const BRAND_CHAR_WIDTH = 6.0; // slightly smaller font

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

  const labelColors: BadgeColors = { top: '#3f3f46', bottom: '#27272a' };

  const R = RADIUS;
  const H = HEIGHT;

  // Label path: rounded left corners, square right corners
  const labelPath = `M${R},0 H${labelWidth} V${H} H${R} A${R},${R},0,0,1,0,${H - R} V${R} A${R},${R},0,0,1,${R},0Z`;

  if (!branding) {
    // Two-segment badge (no branding)
    const totalWidth = labelWidth + valueWidth;
    const valuePath = `M0,0 H${valueWidth - R} A${R},${R},0,0,1,${valueWidth},${R} V${H - R} A${R},${R},0,0,1,${valueWidth - R},${H} H0Z`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${H}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
  </defs>
  <path d="${labelPath}" fill="url(#lg)"/>
  <g transform="translate(${labelWidth},0)"><path d="${valuePath}" fill="url(#vg)"/></g>
  <text x="${labelWidth / 2}" y="${H / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${labelWidth + valueWidth / 2}" y="${H / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>
</svg>`;
  }

  // Three-segment badge with branding
  const brandTextW = measureBrandText(BRAND_TEXT);
  const brandWidth = BRAND_PAD + BRAND_ICON_W + BRAND_ICON_GAP + brandTextW + BRAND_PAD;
  const totalWidth = labelWidth + valueWidth + brandWidth;
  const brandColors: BadgeColors = { top: '#27272a', bottom: '#18181b' };

  // Value path: square both sides (branding takes the rounded right)
  const valuePath = `M0,0 H${valueWidth} V${H} H0Z`;
  // Brand path: square left, rounded right
  const brandPath = `M0,0 H${brandWidth - R} A${R},${R},0,0,1,${brandWidth},${R} V${H - R} A${R},${R},0,0,1,${brandWidth - R},${H} H0Z`;

  const brandX = labelWidth + valueWidth;
  const logoX = brandX + BRAND_PAD;
  const brandTextX = logoX + BRAND_ICON_W + BRAND_ICON_GAP + brandTextW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${H}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${brandColors.top}"/><stop offset="1" stop-color="${brandColors.bottom}"/></linearGradient>
  </defs>
  <path d="${labelPath}" fill="url(#lg)"/>
  <g transform="translate(${labelWidth},0)"><path d="${valuePath}" fill="url(#vg)"/></g>
  <g transform="translate(${brandX},0)"><path d="${brandPath}" fill="url(#bg)"/></g>
  <g transform="translate(${logoX},7)">
    <path d="M1,0 V10 M1,0 H4 M1,10 H4" stroke="#52525b" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M4.5,5 H9 M7,3 L9,5 L7,7" stroke="#22c55e" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="${brandTextX}" y="${H / 2 + 3.5}" fill="#71717a" font-family="${FONT}" font-size="${BRAND_FONT_SIZE}" font-weight="500" text-anchor="middle">${escapeXml(BRAND_TEXT)}</text>
  <text x="${labelWidth / 2}" y="${H / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${labelWidth + valueWidth / 2}" y="${H / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>
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
