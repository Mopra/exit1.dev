import React from 'react';

/**
 * Format timestamp to relative time (e.g., "2m ago", "1h ago", "3d ago")
 */
export const formatLastChecked = (timestamp?: number): string => {
  if (!timestamp) return 'Never';
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
};

/**
 * Format a future timestamp as a relative time (e.g., "in 12m", "in 3h", "in 2d").
 */
export const formatNextRun = (timestamp?: number): string => {
  if (!timestamp) return 'Unknown';
  const now = Date.now();
  if (timestamp <= now) return 'Due';
  const diff = timestamp - now;
  const minutes = Math.ceil(diff / 60000);
  const hours = Math.ceil(diff / 3600000);
  const days = Math.ceil(diff / 86400000);

  if (minutes < 60) return `in ${minutes}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
};

/**
 * Format response time in milliseconds to human readable format
 */
export const formatResponseTime = (time?: number): string => {
  if (!time) return '-';
  if (time < 1000) return `${time}ms`;
  return `${(time / 1000).toFixed(1)}s`;
};

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: 42m, 1h 15m, 5d 3h, 30s
 */
export const formatDuration = (ms: number): string => {
  if (!ms || ms < 0) return '0m';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const remHours = hours % 24;
  const remMinutes = minutes % 60;
  const remSeconds = seconds % 60;

  if (days > 0) return `${days}d ${remHours}h`;
  if (hours > 0) return `${hours}h ${remMinutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${remSeconds}s`;
};

/**
 * Format creation timestamp to relative time
 */
export const formatCreatedAt = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
};

/**
 * Highlight search terms in text by wrapping them in mark tags
 */
export const highlightText = (text: string, query: string): React.ReactNode => {
  if (!query.trim()) return text;
  
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  
  return parts.map((part, index) => 
    regex.test(part) ? (
      <mark key={index} className="bg-primary/20 text-foreground px-1 rounded">
        {part}
      </mark>
    ) : part
  );
}; 