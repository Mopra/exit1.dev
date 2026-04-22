import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { statsCache, historyCache, reportMetricsCache, cacheKeys } from '../utils/cache';
import type {
  ApiResponse,
  AddWebsiteRequest,
  UpdateWebsiteRequest,
  ToggleWebsiteStatusRequest,
  SaveWebhookRequest,
  UpdateWebhookRequest,
  SystemStatus,
  PaginatedResponse,
  CheckHistory,
  ReportMetrics,
  Website,
  LogNote,
  ManualLogEntry,
  ApiKey,
  CreateApiKeyResponse,
  OrganizationBillingProfile
} from './types';
import type { DomainExpiry, DomainIntelligenceItem } from '../types';

// ---------- shared error handling ----------

interface FirebaseFunctionsError {
  message?: string;
  code?: string;
  details?: { retryAfterSeconds?: number };
}

const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  'functions/cors': 'CORS error: Please check your browser settings or try again later',
  'functions/unauthenticated': 'Authentication required. Please sign in again',
  'functions/permission-denied': 'Permission denied. You may not have access to this resource',
  'functions/deadline-exceeded': 'Request timed out. Please try a shorter time range',
  'functions/resource-exhausted': 'Service temporarily unavailable. Please try again in a moment',
  'functions/invalid-argument': 'Invalid request. Please try again',
  'functions/not-found': 'Requested data was not found',
};

function getErrorMessage(
  error: unknown,
  fallback: string,
  overrides?: Record<string, string>,
): string {
  if (!error || typeof error !== 'object') return fallback;
  const e = error as FirebaseFunctionsError;

  // Rate-limit with retry header
  const retryAfter = Number(e.details?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return `Rate limit exceeded. Try again in ${retryAfter}s.`;
  }

  // Per-method overrides → shared map → raw message
  if (e.code) {
    const override = overrides?.[e.code];
    if (override) return override;
    const mapped = FIREBASE_ERROR_MESSAGES[e.code];
    if (mapped) return mapped;
  }

  return e.message || fallback;
}

// ---------- domain-intelligence types ----------

interface RdapDomainInfo {
  expiryDate?: number;
  createdDate?: number;
  updatedDate?: number;
  registrar?: string;
  registrarUrl?: string;
  nameservers?: string[];
  registryStatus?: string[];
  daysUntilExpiry?: number;
}

// ---------- API client ----------

export class Exit1ApiClient {
  private functions = functions;

  // ---- generic call helpers ----

  /** Call a Firebase callable and return `result.data` as `T`. */
  private async call<T>(
    name: string,
    args?: unknown,
    fallback = 'Request failed',
    errorOverrides?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    try {
      const fn = httpsCallable(this.functions, name);
      const result = await fn(args ?? {});
      return { success: true, data: result.data as T };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error, fallback, errorOverrides) };
    }
  }

  /** Call a Firebase callable whose response is `{ data: T }` and unwrap it. */
  private async callUnwrap<T>(
    name: string,
    args?: unknown,
    fallback = 'Request failed',
    errorOverrides?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    try {
      const fn = httpsCallable(this.functions, name);
      const result = await fn(args ?? {});
      const wrapped = result.data as { data: T } | undefined;
      if (wrapped?.data !== undefined) {
        return { success: true, data: wrapped.data };
      }
      return { success: false, error: 'No data received' };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error, fallback, errorOverrides) };
    }
  }

  /** Call a Firebase callable that returns no useful data. */
  private async callVoid(
    name: string,
    args?: unknown,
    fallback = 'Request failed',
    errorOverrides?: Record<string, string>,
  ): Promise<ApiResponse> {
    try {
      const fn = httpsCallable(this.functions, name);
      await fn(args ?? {});
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error, fallback, errorOverrides) };
    }
  }

  // ---- Website Management ----

  addWebsite(request: AddWebsiteRequest) {
    return this.call<{
      id: string;
      status?: 'online' | 'offline' | 'degraded';
      responseTime?: number;
      detailedStatus?: string;
    }>("addCheck", request, 'Failed to add website');
  }

  bulkAddChecks(checks: AddWebsiteRequest[]) {
    return this.call<{ results: Array<{ url: string; name?: string; success: boolean; id?: string; error?: string }> }>(
      "bulkAddChecks", { checks }, 'Failed to bulk import checks',
    );
  }

  exportChecksCsv() {
    return this.call<{ success: boolean; csv: string; rowCount: number; filename: string }>(
      "exportChecksCsv", {}, 'Failed to export checks',
      {
        'functions/permission-denied': 'CSV export is available on Pro and Agency plans',
      },
    );
  }

  getChecks() {
    return this.callUnwrap<Website[]>("getChecks", {}, 'Failed to get checks');
  }

  updateWebsite(request: UpdateWebsiteRequest) {
    return this.callVoid("updateCheck", request, 'Failed to update website');
  }

  deleteWebsite(id: string) {
    return this.callVoid("deleteWebsite", { id }, 'Failed to delete website');
  }

  toggleWebsiteStatus(request: ToggleWebsiteStatusRequest) {
    return this.call<{ disabled: boolean; message: string }>(
      "toggleCheckStatus", request, 'Failed to toggle website status',
    );
  }

  // ---- Maintenance ----

  toggleMaintenanceMode(request: { checkId: string; enabled: boolean; duration?: number; reason?: string }) {
    return this.call<{ maintenanceMode: boolean; message: string }>(
      "toggleMaintenanceMode", request, 'Failed to toggle maintenance mode',
    );
  }

  scheduleMaintenanceWindow(request: { checkId: string; startTime: number; duration: number; reason?: string }) {
    return this.call<{ message: string }>("scheduleMaintenanceWindow", request, 'Failed to schedule maintenance');
  }

  cancelScheduledMaintenance(request: { checkId: string }) {
    return this.call<{ message: string }>("cancelScheduledMaintenance", request, 'Failed to cancel scheduled maintenance');
  }

  setRecurringMaintenance(request: { checkId: string; daysOfWeek: number[]; startTimeMinutes: number; durationMinutes: number; timezone: string; reason?: string }) {
    return this.call<{ message: string }>("setRecurringMaintenance", request, 'Failed to set recurring maintenance');
  }

  deleteRecurringMaintenance(request: { checkId: string }) {
    return this.call<{ message: string }>("deleteRecurringMaintenance", request, 'Failed to delete recurring maintenance');
  }

  // ---- Manual Checks ----

  manualCheck(websiteId: string) {
    return this.call<{ status: string; lastChecked: number }>(
      "manualCheck", { checkId: websiteId }, 'Failed to check website',
    );
  }

  refreshCheckMetadata(websiteId: string) {
    return this.call<{ success: boolean; hasGeo: boolean; country?: string; city?: string; ip?: string; message?: string }>(
      "refreshCheckMetadata", { checkId: websiteId }, 'Failed to refresh geo data',
    );
  }

  updateCheckRegions() {
    return this.call<{ updated: number; updates?: Array<{ id: string; from: string; to: string }> }>(
      "updateCheckRegions", {}, 'Failed to update check regions',
    );
  }

  // ---- Log Notes ----

  getLogNotes(websiteId: string, logId: string) {
    return this.callUnwrap<LogNote[]>("getLogNotes", { websiteId, logId }, 'Failed to load log notes');
  }

  addLogNote(websiteId: string, logId: string, message: string) {
    return this.callUnwrap<LogNote>("addLogNote", { websiteId, logId, message }, 'Failed to add log note');
  }

  updateLogNote(websiteId: string, logId: string, noteId: string, message: string) {
    return this.callUnwrap<LogNote>("updateLogNote", { websiteId, logId, noteId, message }, 'Failed to update log note');
  }

  deleteLogNote(websiteId: string, logId: string, noteId: string) {
    return this.callVoid("deleteLogNote", { websiteId, logId, noteId }, 'Failed to delete log note');
  }

  // ---- Manual Logs ----

  getManualLogs(websiteId: string, startDate?: number, endDate?: number) {
    return this.callUnwrap<ManualLogEntry[]>("getManualLogs", { websiteId, startDate, endDate }, 'Failed to load manual logs');
  }

  addManualLog(websiteId: string, message: string, timestamp?: number, status?: ManualLogEntry['status']) {
    return this.callUnwrap<ManualLogEntry>("addManualLog", { websiteId, message, timestamp, status }, 'Failed to create manual log');
  }

  // ---- BigQuery History & Stats (with caching) ----

  private static readonly BQ_ERRORS: Record<string, string> = {
    'functions/deadline-exceeded': 'Request timed out. The query may be too large. Please try a shorter time range',
  };

  async getCheckHistoryBigQuery(
    websiteId: string,
    page = 1,
    limit = 25,
    searchTerm = '',
    statusFilter = 'all',
    startDate?: number,
    endDate?: number,
    includeFullDetails = false,
  ): Promise<ApiResponse<PaginatedResponse<CheckHistory>>> {
    return this.callUnwrap<PaginatedResponse<CheckHistory>>(
      "getCheckHistoryBigQuery",
      { websiteId, page, limit, searchTerm, statusFilter, startDate, endDate, includeFullDetails },
      'Failed to get BigQuery check history',
      Exit1ApiClient.BQ_ERRORS,
    );
  }

  getCheckHistoryDailySummary(websiteId: string, startDate: number, endDate: number) {
    return this.callUnwrap<PaginatedResponse<CheckHistory>>(
      "getCheckHistoryDailySummary",
      { websiteId, startDate, endDate },
      'Failed to get daily summary',
      Exit1ApiClient.BQ_ERRORS,
    );
  }

  async getCheckStatsBigQuery(
    websiteId: string,
    startDate?: number,
    endDate?: number,
  ): Promise<ApiResponse<ReportMetrics['stats']>> {
    try {
      const timeRange = startDate && endDate ? `${startDate}_${endDate}` : 'default';
      const cacheKey = cacheKeys.stats(websiteId, timeRange);
      const cachedData = statsCache.get(cacheKey);
      if (cachedData) return { success: true, data: cachedData };

      const fn = httpsCallable(this.functions, "getCheckStatsBigQuery");
      const result = await fn({ websiteId, startDate, endDate });
      const wrapped = result.data as { data?: ReportMetrics['stats'] } | undefined;
      if (wrapped?.data) {
        statsCache.set(cacheKey, wrapped.data);
        return { success: true, data: wrapped.data };
      }
      return { success: false, error: 'No data received' };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error, 'Failed to get BigQuery check stats', Exit1ApiClient.BQ_ERRORS) };
    }
  }

  async getCheckStatsBatchBigQuery(
    websiteIds: string[],
    startDate?: number,
    endDate?: number,
  ): Promise<ApiResponse<Array<ReportMetrics['stats'] & { websiteId: string }>>> {
    return this.callUnwrap<Array<ReportMetrics['stats'] & { websiteId: string }>>(
      "getCheckStatsBatchBigQuery",
      { websiteIds, startDate, endDate },
      'Failed to get batch BigQuery check stats',
      Exit1ApiClient.BQ_ERRORS,
    );
  }

  // ---- Status Page ----

  private static readonly STATUS_ERRORS: Record<string, string> = {
    'functions/permission-denied': 'Permission denied. You may not have access to this status page',
    'functions/not-found': 'Status page not found',
  };

  getStatusPageUptime(statusPageId: string) {
    return this.callUnwrap<{ checkUptime: Array<{ checkId: string; uptimePercentage: number }> }>(
      "getStatusPageUptime", { statusPageId }, 'Failed to get status page uptime', Exit1ApiClient.STATUS_ERRORS,
    );
  }

  getStatusPageSnapshot(statusPageId: string) {
    return this.callUnwrap<{ checks: Array<{ checkId: string; name: string; url: string; status: string; lastChecked: number; uptimePercentage: number }> }>(
      "getStatusPageSnapshot", { statusPageId }, 'Failed to get status page data', Exit1ApiClient.STATUS_ERRORS,
    );
  }

  getStatusPageHeartbeat(statusPageId: string) {
    return this.callUnwrap<{ heartbeat: Array<{ checkId: string; days: Array<{ day: number; status: string; totalChecks: number; issueCount: number; onlineChecks?: number; offlineChecks?: number }> }>; days: number; startDate?: number; endDate?: number }>(
      "getStatusPageHeartbeat", { statusPageId }, 'Failed to get status page heartbeat', Exit1ApiClient.STATUS_ERRORS,
    );
  }

  // ---- Report Metrics (with caching) ----

  async getReportMetrics(
    websiteId: string,
    startDate: number,
    endDate: number,
  ): Promise<ApiResponse<ReportMetrics>> {
    try {
      const timeRange = `${startDate}_${endDate}`;
      const cacheKey = cacheKeys.reportMetrics(websiteId, timeRange);
      const cachedData = reportMetricsCache.get(cacheKey);
      if (cachedData) return { success: true, data: cachedData as ReportMetrics };

      const fn = httpsCallable(this.functions, "getCheckReportMetrics");
      const result = await fn({ websiteId, startDate, endDate });
      const wrapped = result.data as { data?: ReportMetrics } | undefined;
      if (wrapped?.data) {
        reportMetricsCache.set(cacheKey, wrapped.data);
        return { success: true, data: wrapped.data };
      }
      return { success: false, error: 'No data received' };
    } catch (error: unknown) {
      return {
        success: false,
        error: getErrorMessage(error, 'Failed to get report metrics', {
          'functions/deadline-exceeded': 'Request timed out. Large report ranges can take a few minutes. Please try again',
        }),
      };
    }
  }

  async getCheckHistoryForStats(
    websiteId: string,
    startDate: number,
    endDate: number,
  ): Promise<ApiResponse<CheckHistory[]>> {
    try {
      const timeRange = `${startDate}_${endDate}`;
      const cacheKey = cacheKeys.historyForStats(websiteId, timeRange);
      const cached = historyCache.get(cacheKey);
      if (cached) return { success: true, data: cached as CheckHistory[] };

      const fn = httpsCallable(this.functions, "getCheckHistoryForStats");
      const result = await fn({ websiteId, startDate, endDate });
      const wrapped = result.data as { data?: CheckHistory[] } | undefined;
      if (wrapped?.data) {
        historyCache.set(cacheKey, wrapped.data, 10 * 60 * 1000);
        return { success: true, data: wrapped.data };
      }
      return { success: false, error: 'No data received' };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error, 'Failed to get BigQuery check history for stats') };
    }
  }

  // ---- Webhooks ----

  saveWebhook(request: SaveWebhookRequest) {
    return this.call<{ id: string }>("saveWebhookSettings", request, 'Failed to save webhook');
  }

  updateWebhook(request: UpdateWebhookRequest) {
    return this.callVoid("updateWebhookSettings", request, 'Failed to update webhook');
  }

  deleteWebhook(id: string) {
    return this.callVoid("deleteWebhook", { id }, 'Failed to delete webhook');
  }

  testWebhook(id: string) {
    return this.call<{ status: number; statusText: string; message: string }>(
      "testWebhook", { id }, 'Failed to test webhook',
    );
  }

  // ---- System ----

  getSystemStatus() {
    return this.call<SystemStatus>("getSystemStatus", {}, 'Failed to get system status');
  }

  // ---- Deploy Mode (admin only) ----

  enableDeployMode(request: { durationMinutes?: number; reason?: string }) {
    return this.call<{ expiresAt: number }>("enableDeployMode", request, 'Failed to enable deploy mode');
  }

  disableDeployMode() {
    return this.callVoid("disableDeployMode", {}, 'Failed to disable deploy mode');
  }

  // ---- Account ----

  deleteUserAccount() {
    return this.call<{ deletedCounts: { checks: number; webhooks: number }; message: string }>(
      "deleteUserAccount", {}, 'Failed to delete user account',
    );
  }

  // ---- Organization ----

  updateOrganizationBillingProfile(organizationId: string, profile: OrganizationBillingProfile | null) {
    return this.callVoid(
      "updateOrganizationBillingProfile",
      { organizationId, profile },
      'Failed to update organization billing profile',
    );
  }

  // ---- API Keys ----

  createApiKey(name: string, scopes: string[] = []) {
    return this.call<CreateApiKeyResponse>("createApiKey", { name, scopes }, 'Failed to create API key');
  }

  listApiKeys() {
    return this.callUnwrap<ApiKey[]>("listApiKeys", {}, 'Failed to list API keys');
  }

  revokeApiKey(id: string) {
    return this.callVoid("revokeApiKey", { id }, 'Failed to revoke API key');
  }

  deleteApiKey(id: string) {
    return this.callVoid("deleteApiKey", { id }, 'Failed to delete API key');
  }

  // ---- Domain Intelligence ----

  private static readonly DOMAIN_PERM_ERROR: Record<string, string> = {
    'functions/permission-denied': 'Domain Intelligence is only available for Nano subscribers',
  };

  getDomainIntelligence() {
    return this.callUnwrap<{ domains: DomainIntelligenceItem[]; count: number }>(
      "getDomainIntelligence", {}, 'Failed to get domain intelligence data',
    );
  }

  enableDomainExpiry(checkId: string, alertThresholds?: number[]) {
    return this.callUnwrap<{ checkId: string; domainExpiry: DomainExpiry }>(
      "enableDomainExpiry", { checkId, alertThresholds },
      'Failed to enable domain expiry monitoring',
      Exit1ApiClient.DOMAIN_PERM_ERROR,
    );
  }

  disableDomainExpiry(checkId: string) {
    return this.callVoid("disableDomainExpiry", { checkId }, 'Failed to disable domain expiry monitoring');
  }

  updateDomainExpiry(checkId: string, alertThresholds: number[]) {
    return this.callVoid("updateDomainExpiry", { checkId, alertThresholds }, 'Failed to update domain expiry settings');
  }

  refreshDomainExpiry(checkId: string) {
    return this.callUnwrap<{ checkId: string } & RdapDomainInfo>(
      "refreshDomainExpiry", { checkId },
      'Failed to refresh domain expiry data',
      { 'functions/resource-exhausted': 'Daily refresh limit reached (50/day)' },
    );
  }

  bulkEnableDomainExpiry(checkIds: string[]) {
    return this.callUnwrap<{ results: Array<{ checkId: string; success: boolean; error?: string; domain?: string }> }>(
      "bulkEnableDomainExpiry", { checkIds },
      'Failed to enable domain expiry monitoring',
      Exit1ApiClient.DOMAIN_PERM_ERROR,
    );
  }

  // ---- Onboarding ----

  submitOnboardingResponse(request: {
    sources: string[];
    useCases: string[];
    teamSize: string;
    planChoice: 'personal' | 'nano' | null;
  }) {
    return this.call<{ success: boolean }>(
      "submitOnboardingResponse", request, 'Failed to save onboarding response',
    );
  }

  getOnboardingStatus() {
    return this.call<{ completed: boolean; completedAt: number | null }>(
      "getOnboardingStatus", {}, 'Failed to fetch onboarding status',
    );
  }

  getOnboardingResponses(limit = 200) {
    return this.call<{
      rows: Array<{
        user_id: string;
        timestamp: number;
        sources: string[];
        use_cases: string[];
        team_size: string | null;
        plan_choice: string | null;
        email: string | null;
      }>;
      total: number;
    }>("getOnboardingResponses", { limit }, 'Failed to fetch onboarding responses');
  }

  deleteOnboardingResponses(rows: Array<{ user_id: string; timestamp: number }>) {
    return this.call<{ deleted: number; pending: number }>(
      "deleteOnboardingResponses", { rows }, 'Failed to delete onboarding responses',
    );
  }
}

// Export singleton instance
export const apiClient = new Exit1ApiClient();
