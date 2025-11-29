import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import { statsCache, cacheKeys } from '../utils/cache';
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
  Website,
  ApiKey,
  CreateApiKeyResponse
} from './types';

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

  async getCheckHistory(websiteId: string): Promise<ApiResponse<GetCheckHistoryResponse>> {
    try {
      const getCheckHistory = httpsCallable(this.functions, "getCheckHistory");
      const result = await getCheckHistory({ websiteId });
      return { success: true, data: result.data as GetCheckHistoryResponse };
    } catch (error: any) {
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
      return { 
        success: false, 
        error: error.message || 'Failed to get check history' 
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
      return {
        success: false,
        error: error.message || 'Failed to get BigQuery check history'
      };
    }
  }

  async getCheckStatsBigQuery(
    websiteId: string,
    startDate?: number,
    endDate?: number
  ): Promise<ApiResponse<{
    totalChecks: number;
    onlineChecks: number;
    offlineChecks: number;
    uptimePercentage: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
  }>> {
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
      return {
        success: false,
        error: error.message || 'Failed to get BigQuery check stats'
      };
    }
  }

  async getCheckHistoryForStats(
    websiteId: string,
    startDate: number,
    endDate: number
  ): Promise<ApiResponse<CheckHistory[]>> {
    try {
      const getCheckHistoryForStats = httpsCallable(this.functions, "getCheckHistoryForStats");
      const result = await getCheckHistoryForStats({ websiteId, startDate, endDate });
      return { success: true, data: (result.data as any).data as CheckHistory[] };
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

  // Email Preferences
  async getEmailOptOut(): Promise<ApiResponse<{ optedOut: boolean }>> {
    try {
      const call = httpsCallable(this.functions, "getEmailOptOut");
      const result = await call({});
      return { success: true, data: result.data as { optedOut: boolean } };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to get email preferences' };
    }
  }

  async updateEmailOptOut(optedOut: boolean): Promise<ApiResponse<{ optedOut: boolean }>> {
    try {
      const call = httpsCallable(this.functions, "updateEmailOptOut");
      const result = await call({ optedOut });
      return { success: true, data: result.data as { optedOut: boolean } };
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to update email preferences' };
    }
  }
}

// Export singleton instance
export const apiClient = new Exit1ApiClient(); 