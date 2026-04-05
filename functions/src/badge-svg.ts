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

  const R = RADIUS;
  const lw = labelWidth;
  const vw = valueWidth;
  const H = HEIGHT;

  // Label path: rounded left corners, square right corners
  const labelPath = `M${R},0 H${lw} V${H} H${R} A${R},${R},0,0,1,0,${H - R} V${R} A${R},${R},0,0,1,${R},0Z`;
  // Value path: square left corners, rounded right corners
  const valuePath = `M0,0 H${vw - R} A${R},${R},0,0,1,${vw},${R} V${H - R} A${R},${R},0,0,1,${vw - R},${H} H0Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${HEIGHT}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${labelColors.top}"/><stop offset="1" stop-color="${labelColors.bottom}"/></linearGradient>
    <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${valueColors.top}"/><stop offset="1" stop-color="${valueColors.bottom}"/></linearGradient>
  </defs>
  <path d="${labelPath}" fill="url(#lg)"/>
  <g transform="translate(${lw},0)"><path d="${valuePath}" fill="url(#vg)"/></g>
  <text x="${lw / 2}" y="${H / 2 + 4}" fill="#d4d4d8" font-family="${FONT}" font-size="11" font-weight="500" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${lw + vw / 2}" y="${H / 2 + 4}" fill="#fff" font-family="${FONT}" font-size="11" font-weight="600" text-anchor="middle">${escapeXml(value)}</text>
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

export function renderStatusBadge(data: BadgeData): string {
  const label = data.name;
  if (data.disabled) return renderBadge(label, 'paused', COLORS.gray);
  if (data.maintenanceMode) return renderBadge(label, 'maintenance', COLORS.amber);
  if (data.status === 'online') return renderBadge(label, 'online', COLORS.green);
  if (data.status === 'offline') return renderBadge(label, 'offline', COLORS.red);
  return renderBadge(label, 'unknown', COLORS.gray);
}

export function renderUptimeBadge(data: BadgeData): string {
  const label = data.name;
  const pct = data.uptimePercentage;
  if (pct == null) return renderBadge(label, 'N/A', COLORS.gray);
  const display = pct >= 99.95 ? '100%' : `${pct.toFixed(1)}%`;
  const color = pct >= 99 ? COLORS.green : pct >= 95 ? COLORS.amber : COLORS.red;
  return renderBadge(label, display, color);
}

export function renderResponseBadge(data: BadgeData): string {
  const label = data.name;
  const ms = data.responseTime;
  if (ms == null) return renderBadge(label, 'N/A', COLORS.gray);
  return renderBadge(label, `${Math.round(ms)}ms`, COLORS.blue);
}

export function renderBadgeSvg(type: BadgeType, data: BadgeData): string {
  switch (type) {
    case 'status': return renderStatusBadge(data);
    case 'uptime': return renderUptimeBadge(data);
    case 'response': return renderResponseBadge(data);
  }
}
