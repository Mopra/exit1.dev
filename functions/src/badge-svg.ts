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

function measureText(text: string): number {
  return Math.ceil(text.length * CHAR_WIDTH);
}

type BadgeColors = {
  top: string;
  bottom: string;
};

export function renderBadge(
  label: string,
  value: string,
  valueColors: BadgeColors
): string {
  const labelWidth = measureText(label) + PADDING_H * 2;
  const valueWidth = measureText(value) + PADDING_H * 2;
  const totalWidth = labelWidth + valueWidth;

  const labelColors: BadgeColors = { top: '#3f3f46', bottom: '#27272a' };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${HEIGHT}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
  </defs>
  <rect width="${labelWidth}" height="${HEIGHT}" rx="${RADIUS}" fill="url(#lg)"/>
  <rect x="${labelWidth - 2}" width="${valueWidth + 2}" height="${HEIGHT}" rx="${RADIUS}" fill="url(#vg)"/>
  <rect x="${labelWidth - 2}" width="${4}" height="${HEIGHT}" fill="url(#lg)"/>
  <text x="${labelWidth / 2}" y="${HEIGHT / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${labelWidth + valueWidth / 2}" y="${HEIGHT / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>
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
  status: 'online' | 'offline' | 'unknown';
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  maintenanceMode?: boolean;
  disabled?: boolean;
  responseTime?: number;
  uptimePercentage?: number;
}

export function renderStatusBadge(data: BadgeData): string {
  if (data.disabled) return renderBadge('exit1 status', 'paused', COLORS.gray);
  if (data.maintenanceMode) return renderBadge('exit1 status', 'maintenance', COLORS.amber);
  if (data.status === 'online') return renderBadge('exit1 status', 'online', COLORS.green);
  if (data.status === 'offline') return renderBadge('exit1 status', 'offline', COLORS.red);
  return renderBadge('exit1 status', 'unknown', COLORS.gray);
}

export function renderUptimeBadge(data: BadgeData): string {
  const pct = data.uptimePercentage;
  if (pct == null) return renderBadge('exit1 uptime', 'N/A', COLORS.gray);
  const display = pct >= 99.95 ? '100%' : `${pct.toFixed(1)}%`;
  const color = pct >= 99 ? COLORS.green : pct >= 95 ? COLORS.amber : COLORS.red;
  return renderBadge('exit1 uptime', display, color);
}

export function renderResponseBadge(data: BadgeData): string {
  const ms = data.responseTime;
  if (ms == null) return renderBadge('exit1 response', 'N/A', COLORS.gray);
  return renderBadge('exit1 response', `${Math.round(ms)}ms`, COLORS.blue);
}

export function renderBadgeSvg(type: BadgeType, data: BadgeData): string {
  switch (type) {
    case 'status': return renderStatusBadge(data);
    case 'uptime': return renderUptimeBadge(data);
    case 'response': return renderResponseBadge(data);
  }
}
