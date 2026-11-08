// Firestore shapes for SLA reporting. See docs/plans/sla-reporting.md, 3.1.

import type { SlaPeriodComputation, SlaStatus } from "./sla-math";

export const SLA_REPORTS_COLLECTION = "sla_reports";
export const SLA_PERIODS_SUBCOLLECTION = "periods";
export const SLA_ROLLUP_SETTINGS_DOC = "system_settings/sla_rollup";

export interface SlaBranding {
  companyName?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
}

export interface SlaReportDoc {
  /** Account owner uid; team members act on it. */
  userId: string;
  name: string;
  targetPercent: number;
  checkIds: string[];
  folderPaths: string[];
  timezone: string;
  countBlockedAsDown: boolean;
  schedule: {
    enabled: boolean;
    recipients: string[];
  };
  branding?: SlaBranding | null;
  /** Normalized recipients who clicked unsubscribe. */
  unsubscribed: string[];
  /** UTC ms: current local month end + 2 h; null when the schedule is off. */
  nextSendAfter: number | null;
  lastSentPeriod?: string | null;
  lastSentAt?: number | null;
  lastSendError?: string | null;
  /** Latest month the rollup wrote as final; the cron stops recomputing it. */
  lastFinalPeriod?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Signed-in uid that created it (owner or team editor). */
  createdBy: string;
  updatedBy?: string;
}

export interface SlaSentRecord {
  sentAt: number;
  timezone: string;
  availability: number | null;
  status: SlaStatus;
  recipients: number;
}

export interface SlaPeriodDoc extends SlaPeriodComputation {
  /** Denormalized so rules need no parent get(). */
  userId: string;
  reportId: string;
  computedAt: number;
  sentRecord?: SlaSentRecord | null;
  /** Set when a time zone change recomputed a final month (audit). */
  previousTimezone?: string | null;
}

export interface SlaRollupSettings {
  /** Cut of the latest successful rollup: data is complete up to here. */
  dataThrough: number;
  ranAt: number;
  /** Latest UTC day ('YYYY-MM-DD') written as a complete day. */
  completeThrough?: string | null;
}
