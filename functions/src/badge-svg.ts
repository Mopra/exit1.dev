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

// Branding footer bar (attached to badge, no gap)
const FOOTER_H = 18;
const FOOTER_Y = HEIGHT;
const BRAND_TEXT = 'exit1.dev';
const BRAND_FONT_SIZE = 9;
const BRAND_CHAR_WIDTH = 5.4;

function measureText(text: string): number {
  return Math.ceil(text.length * CHAR_WIDTH);
}

function measureBrandText(text: string): number {
  return Math.ceil(text.length * BRAND_CHAR_WIDTH);
}

let uidCounter = 0;

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
  const u = uidCounter++;

  const texts = `<text x="${labelWidth / 2}" y="${H / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${labelWidth + valueWidth / 2}" y="${H / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>`;

  if (!branding) {
    // Fully rounded pill: label (rounded left) + value (rounded right)
    const labelPath = `M${R},0 H${labelWidth} V${H} H${R} A${R},${R},0,0,1,0,${H - R} V${R} A${R},${R},0,0,1,${R},0Z`;
    const valuePath = `M0,0 H${valueWidth - R} A${R},${R},0,0,1,${valueWidth},${R} V${H - R} A${R},${R},0,0,1,${valueWidth - R},${H} H0Z`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${H}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
  </defs>
  <path d="${labelPath}" fill="url(#lg${u})"/>
  <g transform="translate(${labelWidth},0)"><path d="${valuePath}" fill="url(#vg${u})"/></g>
  ${texts}
</svg>`;
  }

  // Branded: badge on top (rounded top, square bottom) + footer (square top, rounded bottom)
  const totalH = FOOTER_Y + FOOTER_H;
  const brandColors: BadgeColors = { top: '#18181b', bottom: '#0a0a0a' };

  // Label: rounded top-left, square bottom-left, square right
  const labelPath = `M${R},0 H${labelWidth} V${H} H0 V${R} A${R},${R},0,0,1,${R},0Z`;
  // Value: square left, rounded top-right, square bottom-right
  const valuePath = `M0,0 H${valueWidth - R} A${R},${R},0,0,1,${valueWidth},${R} V${H} H0Z`;
  // Footer: square top, rounded bottom
  const fY = FOOTER_Y;
  const fH = FOOTER_H;
  const fB = fY + fH;
  const footerPath = `M0,${fY} H${totalWidth} V${fB - R} A${R},${R},0,0,1,${totalWidth - R},${fB} H${R} A${R},${R},0,0,1,0,${fB - R}Z`;

  // Center icon + text in footer
  const brandTextW = measureBrandText(BRAND_TEXT);
  const iconW = 10;
  const iconGap = -1;
  const contentW = iconW + iconGap + brandTextW;
  const contentX = (totalWidth - contentW) / 2;
  const textCenterX = contentX + iconW + iconGap + brandTextW / 2;
  const footerCenterY = fY + fH / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalH}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
    <linearGradient id="bg${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${brandColors.top}"/><stop offset="1" stop-color="${brandColors.bottom}"/></linearGradient>
  </defs>
  <path d="${labelPath}" fill="url(#lg${u})"/>
  <g transform="translate(${labelWidth},0)"><path d="${valuePath}" fill="url(#vg${u})"/></g>
  <path d="${footerPath}" fill="url(#bg${u})"/>
  <g transform="translate(${contentX},${footerCenterY - 5}) scale(0.15625)">
    <rect width="64" height="64" rx="14.2" ry="14.2" fill="#52525b"/>
    <path d="M19.8,49.1c-3.7,0-6.5-1-8.4-3.1-1.9-2-2.9-4.8-2.9-8.4s.2-3.4.7-4.8c.5-1.5,1.2-2.7,2.1-3.7.9-1,2.1-1.8,3.4-2.3,1.3-.5,2.8-.8,4.5-.8s3.1.3,4.4.8c1.3.5,2.4,1.3,3.3,2.2.9,1,1.6,2.1,2.1,3.5.5,1.4.8,2.9.8,4.6v1.9h-15.1v.4c0,1.4.4,2.6,1.3,3.5.9.9,2.2,1.3,3.9,1.3s2.4-.2,3.4-.7c.9-.5,1.7-1.2,2.4-2l3.4,3.7c-.9,1.1-2,2-3.6,2.7-1.5.8-3.5,1.2-5.8,1.2ZM19.3,30.6c-1.4,0-2.5.4-3.3,1.3-.8.8-1.2,1.9-1.2,3.4v.3h8.9v-.3c0-1.5-.4-2.6-1.2-3.4-.8-.8-1.8-1.2-3.2-1.2ZM34.6,56.8v-5.2h20.5v5.2h-20.5Z" fill="#18181b"/>
  </g>
  <text x="${textCenterX}" y="${footerCenterY + 3}" fill="#71717a" font-family="${FONT}" font-size="${BRAND_FONT_SIZE}" font-weight="500" text-anchor="middle">${escapeXml(BRAND_TEXT)}</text>
  ${texts}
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
