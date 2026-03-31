const DEFAULT_BASE_URL =
  "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public";

export interface ApiClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface ApiError {
  status: number;
  message: string;
  retryAfter?: number;
}

export class Exit1ApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Api-Key": this.apiKey,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const retryAfter = response.headers.get("Retry-After");
      let message: string;
      try {
        const body = (await response.json()) as { error?: string };
        message = body.error ?? response.statusText;
      } catch {
        message = response.statusText;
      }

      const error: ApiError = {
        status: response.status,
        message,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      };
      throw error;
    }

    return (await response.json()) as T;
  }

  // ── Read endpoints ──

  async listChecks(params?: {
    status?: string;
    limit?: number;
    page?: number;
  }) {
    const query: Record<string, string> = {};
    if (params?.status) query.status = params.status;
    if (params?.limit) query.limit = String(params.limit);
    if (params?.page) query.page = String(params.page);
    return this.request<ListChecksResponse>("/checks", query);
  }

  async getCheck(checkId: string) {
    return this.request<GetCheckResponse>(`/checks/${encodeURIComponent(checkId)}`);
  }

  async getCheckHistory(
    checkId: string,
    params?: {
      from?: string;
      to?: string;
      status?: string;
      limit?: number;
      page?: number;
    }
  ) {
    const query: Record<string, string> = {};
    if (params?.from) query.from = params.from;
    if (params?.to) query.to = params.to;
    if (params?.status) query.status = params.status;
    if (params?.limit) query.limit = String(params.limit);
    if (params?.page) query.page = String(params.page);
    return this.request<GetCheckHistoryResponse>(
      `/checks/${encodeURIComponent(checkId)}/history`,
      query
    );
  }

  async getCheckStats(checkId: string, params?: { ranges?: string }) {
    const query: Record<string, string> = {};
    if (params?.ranges) query.ranges = params.ranges;
    return this.request<GetCheckStatsResponse>(
      `/checks/${encodeURIComponent(checkId)}/stats`,
      query
    );
  }

  async getStatusPageSnapshot(statusPageId: string) {
    return this.request<GetStatusPageSnapshotResponse>(
      `/status-pages/${encodeURIComponent(statusPageId)}/snapshot`
    );
  }
}

// ── Response types ──

export interface CheckSummary {
  id: string;
  name: string | null;
  url: string;
  status: "online" | "offline" | "unknown";
  lastChecked: number;
  responseTime: number | null;
  lastStatusCode: number | null;
  disabled: boolean;
  maintenanceMode: boolean;
  maintenanceScheduledStart: number | null;
  maintenanceRecurring: {
    daysOfWeek: number[];
    startTimeMinutes: number;
    durationMinutes: number;
    timezone: string;
    reason?: string | null;
    createdAt: number;
  } | null;
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    lastChecked?: number;
    error?: string;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number | null;
  totalPages: number | null;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: string | null;
}

export interface ListChecksResponse {
  data: CheckSummary[];
  meta: PaginationMeta;
}

export interface GetCheckResponse {
  data: CheckSummary;
}

export interface HistoryEntry {
  id: string;
  websiteId: string;
  timestamp: number;
  status: string;
  responseTime?: number;
  statusCode?: number;
  error?: string;
  redirectLocation?: string;
  createdAt: number;
}

export interface GetCheckHistoryResponse {
  data: HistoryEntry[];
  meta: PaginationMeta;
}

export interface StatsData {
  totalChecks: number;
  onlineChecks: number;
  offlineChecks: number;
  uptimePercentage: number;
  totalDurationMs: number;
  onlineDurationMs: number;
  offlineDurationMs: number;
  responseSampleCount: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
}

export interface GetCheckStatsResponse {
  data: StatsData | Record<string, StatsData>;
}

export interface StatusPageCheck {
  checkId: string;
  name: string;
  url: string;
  status: "online" | "offline" | "unknown" | "disabled";
  lastChecked: number;
  uptimePercentage: number | null;
  folder: string | null;
}

export interface GetStatusPageSnapshotResponse {
  success: boolean;
  data: {
    checks: StatusPageCheck[];
  };
}
