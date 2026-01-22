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
  GetCheckHistoryResponse,
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

const formatRateLimitError = (error: any, fallback: string): string => {
  const retryAfter = Number(error?.details?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return `Rate limit exceeded. Try again in ${retryAfter}s.`;
  }
  return fallback;
};

// API Client Class
export class Exit1ApiClient {
  private functions = functions;

  // Website Management
  async addWebsite(request: AddWebsiteRequest): Promise<ApiResponse<{ id: string }>> {
    try {
      const addCheck = httpsCallable(this.functions, "addCheck");
      const result = await addCheck(request);
      return { success: true, data: result.data as { id: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to add website' 
      };
    }
  }

  async getChecks(): Promise<ApiResponse<Website[]>> {
    try {
      const getChecks = httpsCallable(this.functions, "getChecks");
      const result = await getChecks({});
      return { success: true, data: (result.data as any).data as Website[] };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to get checks' 
      };
    }
  }

  async updateWebsite(request: UpdateWebsiteRequest): Promise<ApiResponse> {
    try {
      const updateCheck = httpsCallable(this.functions, "updateCheck");
      await updateCheck(request);
      return { success: true };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to update website' 
      };
    }
  }

  async deleteWebsite(id: string): Promise<ApiResponse> {
    try {
      const deleteWebsite = httpsCallable(this.functions, "deleteWebsite");
      await deleteWebsite({ id });
      return { success: true };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to delete website' 
      };
    }
  }

  async toggleWebsiteStatus(request: ToggleWebsiteStatusRequest): Promise<ApiResponse<{ disabled: boolean; message: string }>> {
    try {
      const toggleCheckStatus = httpsCallable(this.functions, "toggleCheckStatus");
      const result = await toggleCheckStatus(request);
      return { success: true, data: result.data as { disabled: boolean; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to toggle website status' 
      };
    }
  }

  async manualCheck(websiteId: string): Promise<ApiResponse<{ status: string; lastChecked: number }>> {
    try {
      const manualCheck = httpsCallable(this.functions, "manualCheck");
      const result = await manualCheck({ checkId: websiteId });
      return { success: true, data: result.data as { status: string; lastChecked: number } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to check website' 
      };
    }
  }

  async updateCheckRegions(): Promise<ApiResponse<{ updated: number; updates?: Array<{ id: string; from: string; to: string }> }>> {
    try {
      const updateCheckRegions = httpsCallable(this.functions, "updateCheckRegions");
      const result = await updateCheckRegions({});
      return { success: true, data: result.data as { updated: number; updates?: Array<{ id: string; from: string; to: string }> } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to update check regions' 
      };
    }
  }

  async getCheckHistory(websiteId: string): Promise<ApiResponse<GetCheckHistoryResponse>> {
    try {
      const getCheckHistory = httpsCallable(this.functions, "getCheckHistory");
      const result = await getCheckHistory({ websiteId });
      return { success: true, data: result.data as GetCheckHistoryResponse };
    } catch (error: any) {
      if (error?.code === 'functions/resource-exhausted') {
        return {
          success: false,
          error: formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.')
        };
      }
      return { 
        success: false, 
        error: error.message || 'Failed to get check history' 
      };
    }
  }

  async getCheckHistoryPaginated(websiteId: string, page: number = 1, limit: number = 10, searchTerm: string = '', statusFilter: string = 'all'): Promise<ApiResponse<PaginatedResponse<CheckHistory>>> {
    try {
      const getCheckHistoryPaginated = httpsCallable(this.functions, "getCheckHistoryPaginated");
      const result = await getCheckHistoryPaginated({ websiteId, page, limit, searchTerm, statusFilter });
      return { success: true, data: result.data as PaginatedResponse<CheckHistory> };
    } catch (error: any) {
      if (error?.code === 'functions/resource-exhausted') {
        return {
          success: false,
          error: formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.')
        };
      }
      return { 
        success: false, 
        error: error.message || 'Failed to get check history' 
      };
    }
  }

  async getLogNotes(websiteId: string, logId: string): Promise<ApiResponse<LogNote[]>> {
    try {
      const getLogNotes = httpsCallable(this.functions, "getLogNotes");
      const result = await getLogNotes({ websiteId, logId });
      return { success: true, data: (result.data as any).data as LogNote[] };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to load log notes'
      };
    }
  }

  async addLogNote(websiteId: string, logId: string, message: string): Promise<ApiResponse<LogNote>> {
    try {
      const addLogNote = httpsCallable(this.functions, "addLogNote");
      const result = await addLogNote({ websiteId, logId, message });
      return { success: true, data: (result.data as any).data as LogNote };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to add log note'
      };
    }
  }

  async updateLogNote(websiteId: string, logId: string, noteId: string, message: string): Promise<ApiResponse<LogNote>> {
    try {
      const updateLogNote = httpsCallable(this.functions, "updateLogNote");
      const result = await updateLogNote({ websiteId, logId, noteId, message });
      return { success: true, data: (result.data as any).data as LogNote };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to update log note'
      };
    }
  }

  async deleteLogNote(websiteId: string, logId: string, noteId: string): Promise<ApiResponse> {
    try {
      const deleteLogNote = httpsCallable(this.functions, "deleteLogNote");
      await deleteLogNote({ websiteId, logId, noteId });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to delete log note'
      };
    }
  }

  async getManualLogs(
    websiteId: string,
    startDate?: number,
    endDate?: number
  ): Promise<ApiResponse<ManualLogEntry[]>> {
    try {
      const getManualLogs = httpsCallable(this.functions, "getManualLogs");
      const result = await getManualLogs({ websiteId, startDate, endDate });
      return { success: true, data: (result.data as any).data as ManualLogEntry[] };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to load manual logs'
      };
    }
  }

  async addManualLog(
    websiteId: string,
    message: string,
    timestamp?: number,
    status?: ManualLogEntry['status']
  ): Promise<ApiResponse<ManualLogEntry>> {
    try {
      const addManualLog = httpsCallable(this.functions, "addManualLog");
      const result = await addManualLog({ websiteId, message, timestamp, status });
      return { success: true, data: (result.data as any).data as ManualLogEntry };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to create manual log'
      };
    }
  }

    async getCheckHistoryBigQuery(
    websiteId: string, 
    page: number = 1, 
    limit: number = 25, 
    searchTerm: string = '', 
    statusFilter: string = 'all',
    startDate?: number,
    endDate?: number
  ): Promise<ApiResponse<PaginatedResponse<CheckHistory>>> {
    try {
      const getCheckHistoryBigQuery = httpsCallable(this.functions, "getCheckHistoryBigQuery");
      const result = await getCheckHistoryBigQuery({ 
        websiteId, 
        page, 
        limit, 
        searchTerm, 
        statusFilter,
        startDate,
        endDate
      });
      return { success: true, data: (result.data as any).data as PaginatedResponse<CheckHistory> };
    } catch (error: any) {
      // Extract more detailed error information
      let errorMessage = 'Failed to get BigQuery check history';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        // Firebase Functions error codes
        switch (error.code) {
          case 'functions/cors':
            errorMessage = 'CORS error: Please check your browser settings or try again later';
            break;
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this resource';
            break;
          case 'functions/deadline-exceeded':
            errorMessage = 'Request timed out. The query may be too large. Please try a shorter time range';
            break;
          case 'functions/resource-exhausted':
            errorMessage = formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.');
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getCheckHistoryDailySummary(
    websiteId: string,
    startDate: number,
    endDate: number
  ): Promise<ApiResponse<PaginatedResponse<CheckHistory>>> {
    try {
      const getCheckHistoryDailySummary = httpsCallable(this.functions, "getCheckHistoryDailySummary");
      const result = await getCheckHistoryDailySummary({ 
        websiteId,
        startDate,
        endDate
      });
      return { success: true, data: (result.data as any).data as PaginatedResponse<CheckHistory> };
    } catch (error: any) {
      let errorMessage = 'Failed to get daily summary';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/cors':
            errorMessage = 'CORS error: Please check your browser settings or try again later';
            break;
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this resource';
            break;
          case 'functions/deadline-exceeded':
            errorMessage = 'Request timed out. Please try again';
            break;
          case 'functions/resource-exhausted':
            errorMessage = 'Service temporarily unavailable. Please try again in a moment';
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getCheckStatsBigQuery(
    websiteId: string,
    startDate?: number,
    endDate?: number
  ): Promise<ApiResponse<ReportMetrics['stats']>> {
    try {
      // Check cache first
      const timeRange = startDate && endDate ? `${startDate}_${endDate}` : 'default';
      const cacheKey = cacheKeys.stats(websiteId, timeRange);
      const cachedData = statsCache.get(cacheKey);
      
      if (cachedData) {
        return { success: true, data: cachedData };
      }
      
      const getCheckStatsBigQuery = httpsCallable(this.functions, "getCheckStatsBigQuery");
      const result = await getCheckStatsBigQuery({ websiteId, startDate, endDate });
      
      if (result.data && (result.data as any).data) {
        const data = (result.data as any).data;
        // Cache the result
        statsCache.set(cacheKey, data);
        return { success: true, data };
      }
      
      return { success: false, error: 'No data received' };
    } catch (error: any) {
      let errorMessage = 'Failed to get BigQuery check stats';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/cors':
            errorMessage = 'CORS error: Please check your browser settings or try again later';
            break;
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this resource';
            break;
          case 'functions/invalid-argument':
            errorMessage = 'Invalid request. Please try again';
            break;
          case 'functions/not-found':
            errorMessage = 'Requested data was not found';
            break;
          case 'functions/deadline-exceeded':
            errorMessage = 'Request timed out. The query may be too large. Please try a shorter time range';
            break;
          case 'functions/resource-exhausted':
            errorMessage = 'Service temporarily unavailable. Please try again in a moment';
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getStatusPageUptime(
    statusPageId: string
  ): Promise<ApiResponse<{ checkUptime: Array<{ checkId: string; uptimePercentage: number }> }>> {
    try {
      const getStatusPageUptime = httpsCallable(this.functions, "getStatusPageUptime");
      const result = await getStatusPageUptime({ statusPageId });
      return { success: true, data: (result.data as any).data as { checkUptime: Array<{ checkId: string; uptimePercentage: number }> } };
    } catch (error: any) {
      let errorMessage = 'Failed to get status page uptime';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this status page';
            break;
          case 'functions/not-found':
            errorMessage = 'Status page not found';
            break;
          case 'functions/resource-exhausted':
            errorMessage = formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.');
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getStatusPageSnapshot(
    statusPageId: string
  ): Promise<ApiResponse<{ checks: Array<{ checkId: string; name: string; url: string; status: string; lastChecked: number; uptimePercentage: number }> }>> {
    try {
      const getStatusPageSnapshot = httpsCallable(this.functions, "getStatusPageSnapshot");
      const result = await getStatusPageSnapshot({ statusPageId });
      return { success: true, data: (result.data as any).data as { checks: Array<{ checkId: string; name: string; url: string; status: string; lastChecked: number; uptimePercentage: number }> } };
    } catch (error: any) {
      let errorMessage = 'Failed to get status page data';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this status page';
            break;
          case 'functions/not-found':
            errorMessage = 'Status page not found';
            break;
          case 'functions/resource-exhausted':
            errorMessage = formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.');
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getStatusPageHeartbeat(
    statusPageId: string
  ): Promise<ApiResponse<{ heartbeat: Array<{ checkId: string; days: Array<{ day: number; status: string; totalChecks: number; issueCount: number }> }>; days: number; startDate?: number; endDate?: number }>> {
    try {
      const getStatusPageHeartbeat = httpsCallable(this.functions, "getStatusPageHeartbeat");
      const result = await getStatusPageHeartbeat({ statusPageId });
      return { success: true, data: (result.data as any).data as { heartbeat: Array<{ checkId: string; days: Array<{ day: number; status: string; totalChecks: number; issueCount: number }> }>; days: number; startDate?: number; endDate?: number } };
    } catch (error: any) {
      let errorMessage = 'Failed to get status page heartbeat';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this status page';
            break;
          case 'functions/not-found':
            errorMessage = 'Status page not found';
            break;
          case 'functions/resource-exhausted':
            errorMessage = formatRateLimitError(error, 'Rate limit exceeded. Please try again shortly.');
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getReportMetrics(
    websiteId: string,
    startDate: number,
    endDate: number
  ): Promise<ApiResponse<ReportMetrics>> {
    try {
      const timeRange = `${startDate}_${endDate}`;
      const cacheKey = cacheKeys.reportMetrics(websiteId, timeRange);
      const cachedData = reportMetricsCache.get(cacheKey);

      if (cachedData) {
        return { success: true, data: cachedData as ReportMetrics };
      }

      const getCheckReportMetrics = httpsCallable(this.functions, "getCheckReportMetrics");
      const result = await getCheckReportMetrics({ websiteId, startDate, endDate });

      if (result.data && (result.data as any).data) {
        const data = (result.data as any).data as ReportMetrics;
        reportMetricsCache.set(cacheKey, data);
        return { success: true, data };
      }

      return { success: false, error: 'No data received' };
    } catch (error: any) {
      let errorMessage = 'Failed to get report metrics';
      if (error?.message) {
        errorMessage = error.message;
      } else if (error?.code) {
        switch (error.code) {
          case 'functions/cors':
            errorMessage = 'CORS error: Please check your browser settings or try again later';
            break;
          case 'functions/unauthenticated':
            errorMessage = 'Authentication required. Please sign in again';
            break;
          case 'functions/permission-denied':
            errorMessage = 'Permission denied. You may not have access to this resource';
            break;
          case 'functions/invalid-argument':
            errorMessage = 'Invalid request. Please try again';
            break;
          case 'functions/not-found':
            errorMessage = 'Requested data was not found';
            break;
          case 'functions/deadline-exceeded':
            errorMessage = 'Request timed out. Large report ranges can take a few minutes. Please try again';
            break;
          case 'functions/resource-exhausted':
            errorMessage = 'Service temporarily unavailable. Please try again in a moment';
            break;
          default:
            errorMessage = error.message || `Error: ${error.code}`;
        }
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async getCheckHistoryForStats(
    websiteId: string,
    startDate: number,
    endDate: number
  ): Promise<ApiResponse<CheckHistory[]>> {
    try {
      const timeRange = `${startDate}_${endDate}`;
      const cacheKey = cacheKeys.historyForStats(websiteId, timeRange);
      const cached = historyCache.get(cacheKey);
      if (cached) {
        return { success: true, data: cached as CheckHistory[] };
      }

      const getCheckHistoryForStats = httpsCallable(this.functions, "getCheckHistoryForStats");
      const result = await getCheckHistoryForStats({ websiteId, startDate, endDate });
      const data = (result.data as any).data as CheckHistory[];
      historyCache.set(cacheKey, data, 10 * 60 * 1000); // 10 minutes
      return { success: true, data };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to get BigQuery check history for stats'
      };
    }
  }







  // Webhook Management
  async saveWebhook(request: SaveWebhookRequest): Promise<ApiResponse<{ id: string }>> {
    try {
      const saveWebhookSettings = httpsCallable(this.functions, "saveWebhookSettings");
      const result = await saveWebhookSettings(request);
      return { success: true, data: result.data as { id: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to save webhook' 
      };
    }
  }

  async updateWebhook(request: UpdateWebhookRequest): Promise<ApiResponse> {
    try {
      const updateWebhookSettings = httpsCallable(this.functions, "updateWebhookSettings");
      await updateWebhookSettings(request);
      return { success: true };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to update webhook' 
      };
    }
  }

  async deleteWebhook(id: string): Promise<ApiResponse> {
    try {
      const deleteWebhook = httpsCallable(this.functions, "deleteWebhook");
      await deleteWebhook({ id });
      return { success: true };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to delete webhook' 
      };
    }
  }

  async testWebhook(id: string): Promise<ApiResponse<{ status: number; statusText: string; message: string }>> {
    try {
      const testWebhook = httpsCallable(this.functions, "testWebhook");
      const result = await testWebhook({ id });
      return { success: true, data: result.data as { status: number; statusText: string; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to test webhook' 
      };
    }
  }

  // System Management
  async getSystemStatus(): Promise<ApiResponse<SystemStatus>> {
    try {
      const getSystemStatus = httpsCallable(this.functions, "getSystemStatus");
      const result = await getSystemStatus({});
      return { success: true, data: result.data as SystemStatus };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to get system status' 
      };
    }
  }



  // Account Management
  async deleteUserAccount(): Promise<ApiResponse<{ deletedCounts: { checks: number; webhooks: number }; message: string }>> {
    try {
      const deleteUserAccount = httpsCallable(this.functions, "deleteUserAccount");
      const result = await deleteUserAccount({});
      return { success: true, data: result.data as { deletedCounts: { checks: number; webhooks: number }; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to delete user account' 
      };
    }
  }

  // Organization Management
  async updateOrganizationBillingProfile(
    organizationId: string,
    profile: OrganizationBillingProfile | null
  ): Promise<ApiResponse> {
    try {
      const call = httpsCallable(this.functions, "updateOrganizationBillingProfile");
      await call({ organizationId, profile });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to update organization billing profile'
      };
    }
  }

  // API Keys
  async createApiKey(name: string, scopes: string[] = []): Promise<ApiResponse<CreateApiKeyResponse>> {
    try {
      const call = httpsCallable(this.functions, "createApiKey");
      const result = await call({ name, scopes });
      return { success: true, data: result.data as any };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to create API key' };
    }
  }

  async listApiKeys(): Promise<ApiResponse<ApiKey[]>> {
    try {
      const call = httpsCallable(this.functions, "listApiKeys");
      const result = await call({});
      return { success: true, data: (result.data as any).data as ApiKey[] };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to list API keys' };
    }
  }

  async revokeApiKey(id: string): Promise<ApiResponse> {
    try {
      const call = httpsCallable(this.functions, "revokeApiKey");
      await call({ id });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to revoke API key' };
    }
  }

  async deleteApiKey(id: string): Promise<ApiResponse> {
    try {
      const call = httpsCallable(this.functions, "deleteApiKey");
      await call({ id });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to delete API key' };
    }
  }
}

// Export singleton instance
export const apiClient = new Exit1ApiClient(); 
