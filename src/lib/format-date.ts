/**
 * Format a timestamp as a short date (e.g. "Mar 5, 2026")
 */
export function formatShortDate(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a timestamp as a long date (e.g. "Thursday, March 5, 2026")
 */
export function formatLongDate(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Format a timestamp as relative time (e.g. "5m ago", "in 3h")
 */
export function formatRelativeTime(timestamp?: number, isFuture = false): string {
  if (!timestamp) return '—';
  const now = Date.now();
  const diff = isFuture ? timestamp - now : now - timestamp;
  const absDiff = Math.abs(diff);
  const minutes = Math.floor(absDiff / 60000);
  const hours = Math.floor(absDiff / 3600000);
  const days = Math.floor(absDiff / 86400000);

  if (isFuture) {
    if (diff <= 0) return 'now';
    if (days > 0) return `in ${days}d`;
    if (hours > 0) return `in ${hours}h`;
    if (minutes > 0) return `in ${minutes}m`;
    return 'in < 1m';
  }

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
