import React from 'react';
import {
  Globe,
  Code,
  Server,
  Radio,
  Activity,
  ShieldCheck,
  AlertTriangle,
  Zap,
  ArrowRight,
} from 'lucide-react';
import type { Website } from '../types';

// ── Region labels ──────────────────────────────────────────────────────────────

export const getRegionLabel = (region?: Website['checkRegion']): { short: string; long: string } | null => {
  if (!region) return null;
  switch (region) {
    case 'us-central1':
      return { short: 'US-C', long: 'US Central (Iowa)' };
    case 'europe-west1':
      return { short: 'EU-BE', long: 'Europe West (Belgium)' };
    case 'asia-southeast1':
      return { short: 'APAC', long: 'Asia Pacific (Singapore)' };
    case 'vps-eu-1':
      return { short: 'EU-Turbo', long: 'Europe Turbo (Frankfurt, DE)' };
    default:
      return { short: String(region), long: String(region) };
  }
};

// ── Check type icon / label ────────────────────────────────────────────────────

export const getTypeIcon = (type?: string, className = 'w-4 h-4 text-primary') => {
  switch (type) {
    case 'rest_endpoint':
      return <Code className={className} />;
    case 'tcp':
      return <Server className={className} />;
    case 'udp':
      return <Radio className={className} />;
    case 'ping':
      return <Activity className={className} />;
    case 'websocket':
      return <Zap className={className} />;
    case 'redirect':
      return <ArrowRight className={className} />;
    default:
      return <Globe className={className} />;
  }
};

export const getTypeLabel = (type?: string): string => {
  switch (type) {
    case 'rest_endpoint':
      return 'API';
    case 'tcp':
      return 'TCP';
    case 'udp':
      return 'UDP';
    case 'ping':
      return 'Ping';
    case 'websocket':
      return 'WebSocket';
    case 'redirect':
      return 'Redirect';
    default:
      return 'Website';
  }
};

// ── SSL certificate status ─────────────────────────────────────────────────────

export const getSSLCertificateStatus = (check: Website) => {
  if (check.url.startsWith('tcp://')) {
    return { valid: true, icon: Server, color: 'text-muted-foreground', text: 'TCP' };
  }
  if (check.url.startsWith('udp://')) {
    return { valid: true, icon: Radio, color: 'text-muted-foreground', text: 'UDP' };
  }
  if (check.url.startsWith('ping://')) {
    return { valid: true, icon: Activity, color: 'text-muted-foreground', text: 'Ping' };
  }
  if (check.url.startsWith('ws://') || check.url.startsWith('wss://')) {
    return { valid: true, icon: Zap, color: 'text-muted-foreground', text: check.url.startsWith('wss://') ? 'WSS' : 'WS' };
  }
  if (!check.url.startsWith('https://')) {
    return { valid: true, icon: ShieldCheck, color: 'text-muted-foreground', text: 'HTTP' };
  }

  if (!check.sslCertificate) {
    return { valid: false, icon: AlertTriangle, color: 'text-muted-foreground', text: 'Unknown' };
  }

  if (check.sslCertificate.valid) {
    const daysUntilExpiry = check.sslCertificate.daysUntilExpiry || 0;
    if (daysUntilExpiry <= 30) {
      return {
        valid: true,
        icon: AlertTriangle,
        color: 'text-primary',
        text: `${daysUntilExpiry} days`
      };
    }
    return {
      valid: true,
      icon: ShieldCheck,
      color: 'text-primary',
      text: 'Valid'
    };
  } else {
    return {
      valid: false,
      icon: AlertTriangle,
      color: 'text-destructive',
      text: 'Invalid'
    };
  }
};

// ── Maintenance formatting ─────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const formatRecurringSummary = (recurring: NonNullable<Website['maintenanceRecurring']>): string => {
  const days = [...recurring.daysOfWeek].sort().map(d => DAY_NAMES[d]).join(', ');
  const hours = Math.floor(recurring.startTimeMinutes / 60);
  const mins = recurring.startTimeMinutes % 60;
  const time = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  const dur = recurring.durationMinutes >= 60
    ? `${recurring.durationMinutes / 60}h`
    : `${recurring.durationMinutes}m`;
  return `${days} at ${time} for ${dur}`;
};

export const formatMaintenanceDuration = (ms: number): string => {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${mins / 60}h`;
  return `${mins}m`;
};

// ── URL → friendly name ────────────────────────────────────────────────────────

export const generateFriendlyName = (url: string): string => {
  try {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    const urlObj = new URL(fullUrl);
    const hostname = urlObj.hostname;

    if (hostname && hostname.length > 0) {
      let friendlyName = hostname
        .replace(/^www\./, '')
        .split('.')
        .slice(0, -1)
        .join('.')
        .replace(/[-_.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

      if (!friendlyName || friendlyName.length < 2) {
        const domainWithoutExtension = hostname
          .replace(/^www\./, '')
          .split('.')
          .slice(0, -1)
          .join('.');
        friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
      }

      return friendlyName;
    }
  } catch (error) {
    console.error('Error generating name from URL:', error);
  }

  // Fallback
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
};
