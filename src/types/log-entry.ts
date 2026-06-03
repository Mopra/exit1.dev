/** UI view-model for a single log row (both automatic and manual entries). */
export interface LogEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  time: string;
  date: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
  statusCode?: number;
  responseTime?: number;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  error?: string;
  timestamp: number;
  timezone?: string;
  localTime?: string;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  pingTtl?: number;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
  redirectLocation?: string;
  isManual?: boolean;
  manualMessage?: string;
  maintenanceType?: 'maintenance_start' | 'maintenance_end';
  maintenanceDuration?: number;
  // Multi-region (Phase 1 + Phase 2)
  region?: string;
  peerRegion?: string;
  peerStatus?: 'online' | 'offline';
  peerResponseTime?: number;
  peerStatusCode?: number;
  peerCheckedAt?: number;
  peerReachable?: boolean;
  // confirmed=false marks an unconfirmed/transient probe failure that did
  // NOT flip the check's status (held by the consecutive-failures gate or
  // by peer suppression). UI renders these in yellow with an "unconfirmed"
  // tooltip so the user understands no alert was sent by design.
  confirmed?: boolean;
  // alert_sent reflects whether triggerAlert delivered ≥1 channel for the
  // status transition this row represents. Undefined on non-transition
  // rows (heartbeats, peer-audit rows) so the UI can distinguish
  // "alert attempted and failed" from "no alert attempt".
  alertSent?: boolean;
}
