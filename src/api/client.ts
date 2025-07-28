import { httpsCallable } from "firebase/functions";
import { functions } from '../firebase';
import type { 
  ApiResponse,
  AddWebsiteRequest,
  UpdateWebsiteRequest,
  ToggleWebsiteStatusRequest,
  ReorderWebsitesRequest,
  SaveWebhookRequest,
  UpdateWebhookRequest,
  SystemStatus,
  DiscordAuthRequest,
  GetCheckHistoryResponse,
  GetCheckAggregationsResponse
} from './types';

// API Client Class
export class Exit1ApiClient {
  private functions = functions;

  // Website Management
  async addWebsite(request: AddWebsiteRequest): Promise<ApiResponse<{ id: string }>> {
    try {
      const addWebsite = httpsCallable(this.functions, "addWebsite");
      const result = await addWebsite(request);
      return { success: true, data: result.data as { id: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to add website' 
      };
    }
  }

  async updateWebsite(request: UpdateWebsiteRequest): Promise<ApiResponse> {
    try {
      const updateWebsite = httpsCallable(this.functions, "updateWebsite");
      await updateWebsite(request);
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
      const toggleWebsiteStatus = httpsCallable(this.functions, "toggleWebsiteStatus");
      const result = await toggleWebsiteStatus(request);
      return { success: true, data: result.data as { disabled: boolean; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to toggle website status' 
      };
    }
  }

  async reorderWebsites(request: ReorderWebsitesRequest): Promise<ApiResponse> {
    try {
      const reorderWebsites = httpsCallable(this.functions, "reorderWebsites");
      await reorderWebsites(request);
      return { success: true };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to reorder websites' 
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

  async getCheckAggregations(websiteId: string, days: number = 7): Promise<ApiResponse<GetCheckAggregationsResponse>> {
    try {
      const getCheckAggregations = httpsCallable(this.functions, "getCheckAggregations");
      const result = await getCheckAggregations({ websiteId, days });
      return { success: true, data: result.data as GetCheckAggregationsResponse };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to get check aggregations' 
      };
    }
  }

  async migrateWebsites(): Promise<ApiResponse<{ migratedCount: number; message: string }>> {
    try {
      const migrateWebsites = httpsCallable(this.functions, "migrateWebsites");
      const result = await migrateWebsites({});
      return { success: true, data: result.data as { migratedCount: number; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to migrate websites' 
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

  // Discord Integration
  async handleDiscordAuth(request: DiscordAuthRequest): Promise<ApiResponse<{ inviteUrl?: string; alreadyMember: boolean; message: string }>> {
    try {
      const handleDiscordAuth = httpsCallable(this.functions, "handleDiscordAuth");
      const result = await handleDiscordAuth(request);
      return { success: true, data: result.data as { inviteUrl?: string; alreadyMember: boolean; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to handle Discord auth' 
      };
    }
  }

  // Account Management
  async deleteUserAccount(): Promise<ApiResponse<{ deletedCounts: { checks: number; webhooks: number; discordConnection: number }; message: string }>> {
    try {
      const deleteUserAccount = httpsCallable(this.functions, "deleteUserAccount");
      const result = await deleteUserAccount({});
      return { success: true, data: result.data as { deletedCounts: { checks: number; webhooks: number; discordConnection: number }; message: string } };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Failed to delete user account' 
      };
    }
  }
}

// Export singleton instance
export const apiClient = new Exit1ApiClient(); 