// Shared types for the application

export interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline' | 'unknown';
  lastChecked?: number;
  downtimeCount?: number;
  lastDowntime?: number;
  createdAt?: number;
  updatedAt?: number;
  orderIndex?: number; // For custom drag & drop ordering
  lastStatusCode?: number;
  responseTime?: number;
  lastError?: string;
  userId?: string;
  
  // Cost optimization fields
  checkFrequency?: number; // minutes between checks
  consecutiveFailures?: number; // track consecutive failures
  lastFailureTime?: number; // when to resume checking after failures
  userTier?: 'free' | 'premium'; // user subscription tier
  
  // Dead site management
  disabled?: boolean; // permanently disabled due to extended downtime
  disabledAt?: number; // when the site was disabled
  disabledReason?: string; // reason for disabling (e.g., "Extended downtime")
} 