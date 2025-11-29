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
  timeBasedDowntime,
  addCheck,
  getChecks,
  updateCheck,
  deleteWebsite,
  toggleCheckStatus,
  manualCheck,
} from './checks';

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
} from './webhooks';

// Email settings functions
export {
  saveEmailSettings,
  updateEmailPerCheck,
  getEmailSettings,
  sendTestEmail,
  sendSingleEmail,
  sendBulkEmail,
} from './email';

// Check history and statistics functions
export {
  getCheckHistory,
  getCheckHistoryPaginated,
  getCheckHistoryBigQuery,
  getCheckStatsBigQuery,
  getCheckHistoryForStats,
} from './history';

// API key management functions
export {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from './api-keys';

// User management functions
export {
  getAllUsers,
  updateUser,
  deleteUser,
  bulkDeleteUsers,
  deleteUserAccount,
  updateEmailOptOut,
  getEmailOptOut,
  optOutByEmail,
} from './users';

// Badge API function
export { badgeData } from './badge';

// Public API
export { publicApi } from './public-api';

// Admin and migration functions
export {
  getAdminStats,
  getBadgeDomains,
  getBigQueryUsage,
} from './admin';

// System Notifications
export {
  createSystemNotification,
  toggleSystemNotification,
  deleteSystemNotification,
} from './notifications';
