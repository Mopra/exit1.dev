/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Import initialization FIRST to ensure Firebase Admin and shared state are initialized
// before any modules that depend on them are imported
import './init';

// Re-export all Firebase Functions from their respective modules
// Exports maintain identical names and signatures for zero-downtime deployment

// Check management functions
export {
  checkAllChecks,
  checkAllChecksEU,
  checkAllChecksAPAC,
  addCheck,
  getChecks,
  updateCheck,
  deleteWebsite,
  toggleCheckStatus,
  manualCheck,
  updateCheckRegions,
} from './checks';

// Check event handlers (no longer exported as Cloud Functions - called directly from check logic)
// The logCheckDisabled Firestore trigger was removed to eliminate ~170K+ wasted invocations/day.
// handleCheckDisabled is now called directly from checks.ts and toggleCheckStatus.

// Scheduled security refresh
export { refreshSecurityMetadata } from './security-refresh';

// System status function
export { getSystemStatus } from './system';

// Webhook management functions
export {
  saveWebhookSettings,
  updateWebhookSettings,
  deleteWebhook,
  testWebhook,
  bulkDeleteWebhooks,
  bulkUpdateWebhookStatus,
} from './webhooks';

// Email settings functions
export {
  saveEmailSettings,
  updateEmailPerCheck,
  getEmailSettings,
  getEmailUsage,
  sendTestEmail,
  bulkUpdateEmailPerCheck,
} from './email';

// SMS settings functions
export {
  saveSmsSettings,
  updateSmsPerCheck,
  getSmsSettings,
  getSmsUsage,
  sendTestSms,
  bulkUpdateSmsPerCheck,
} from './sms';

// Check history and statistics functions
export {
  getCheckHistoryBigQuery,
  getCheckStatsBigQuery,
  getCheckStatsBatchBigQuery, // Batch stats for multiple websites (cost optimized)
  getCheckReportMetrics,
  getCheckHistoryForStats,
  getCheckHistoryDailySummary,
  purgeBigQueryHistory,
  aggregateDailySummariesScheduled, // Pre-aggregate daily summaries for cost optimization
} from './history';

// Log notes
export {
  getLogNotes,
  addLogNote,
  updateLogNote,
  deleteLogNote,
} from './log-notes';

// Manual logs
export {
  getManualLogs,
  addManualLog,
} from './manual-logs';

// API key management functions
export {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
} from './api-keys';

// User management functions
export {
  getAllUsers,
  deleteUser,
  bulkDeleteUsers,
  deleteUserAccount,
} from './users';

// Organization management functions
export { updateOrganizationBillingProfile } from './organizations';

// Status pages
export { getStatusPageUptime, getStatusPageSnapshot, getStatusPageHeartbeat } from './status-pages';

// Public API
export { publicApi } from './public-api';

// Admin functions
export {
  getAdminStats,
  getBigQueryUsage,
  investigateCheck,
} from './admin';

// System Notifications
export {
  createSystemNotification,
  toggleSystemNotification,
  deleteSystemNotification,
  createUserNotification,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteUserNotification,
} from './notifications';

// Clerk webhook and Resend Audience sync
export {
  clerkWebhook,
  syncClerkUsersToResend,
} from './clerk-webhook';
