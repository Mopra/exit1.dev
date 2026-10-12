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

// The lazy exports below need a synchronous require() per module (see lazy()).
/* eslint-disable @typescript-eslint/no-require-imports */

// Tier sync function (force-refreshes Firestore tier cache from Clerk)
export { syncMyTier } from './init';

// Every other function is exported lazily: a getter that requires its module on
// first access. Each Gen2 function runs in its own container, and the functions
// framework only reads the one export named by its target, so a cold start loads
// that function's module chain instead of the whole bundle (Twilio, Resend,
// BigQuery, the MCP SDK, ...). Deploy discovery enumerates the exports, which
// runs every getter, so every function stays discoverable.
//
// The `typeof import()` return type is erased at compile time and makes tsc check
// each name against the module. Keep the require() a literal path in this
// `lazy((): typeof import('./x') => require('./x'), [...])` shape:
// scripts/deploy-changed.mjs parses it to map each function to its source file.
function lazy<M>(load: () => M, names: readonly (keyof M & string)[]): void {
  for (const name of names) {
    Object.defineProperty(exports, name, {
      enumerable: true,
      get() {
        const fn = load()[name];
        // Discovery skips undefined exports silently, and a full deploy would
        // then delete that function. Fail loudly instead.
        if (fn === undefined) throw new Error(`index.ts: ${name} is not exported by its module`);
        return fn;
      },
    });
  }
}

// Check management functions
lazy((): typeof import('./checks') => require('./checks'), [
  'addCheck',
  'bulkAddChecks',
  'getChecks',
  'updateCheck',
  'deleteWebsite',
  'toggleCheckStatus',
  'toggleMaintenanceMode',
  'scheduleMaintenanceWindow',
  'cancelScheduledMaintenance',
  'setRecurringMaintenance',
  'deleteRecurringMaintenance',
  'manualCheck',
  'updateCheckRegions',
]);

// CSV export (Pro+ tier-gated)
lazy((): typeof import('./csv-export') => require('./csv-export'), ['exportChecksCsv']);

// Check event handlers (no longer exported as Cloud Functions - called directly from check logic)
// The logCheckDisabled Firestore trigger was removed to eliminate ~170K+ wasted invocations/day.
// handleCheckDisabled is now called directly from checks.ts and toggleCheckStatus.

// Scheduled jobs (security, target metadata, domain expiry, history purge and
// aggregation, public stats and monitors, lifecycle sweep) run on the VPS, not
// as Cloud Functions: see vps/src/cron.ts. That removes a cold start per run
// and the Cloud Scheduler job fees.

// On-demand target metadata refresh (DNS + GeoIP)
lazy((): typeof import('./target-metadata-refresh') => require('./target-metadata-refresh'), ['refreshCheckMetadata']);

// System status function
lazy((): typeof import('./system') => require('./system'), ['getSystemStatus']);

// Webhook management functions
lazy((): typeof import('./webhooks') => require('./webhooks'), [
  'saveWebhookSettings',
  'updateWebhookSettings',
  'deleteWebhook',
  'testWebhook',
  'bulkDeleteWebhooks',
  'bulkUpdateWebhookStatus',
]);

// Email settings functions
lazy((): typeof import('./email') => require('./email'), [
  'saveEmailSettings',
  'enableEmailAlertsForAllChecks',
  'updateEmailPerCheck',
  'updateEmailPerFolder',
  'getEmailSettings',
  'getEmailUsage',
  'sendTestEmail',
  'bulkUpdateEmailPerCheck',
  'getEmailSuppressions',
  'resumeSuppressedEmail',
]);

// Resend bounce/complaint webhook (email suppression)
lazy((): typeof import('./resend-webhook') => require('./resend-webhook'), ['resendWebhook']);

// Day3 delivery-event webhook — the second feed into the same
// `emailSuppressions` store, for traffic sent via Day3.
lazy((): typeof import('./day3-webhook') => require('./day3-webhook'), ['day3Webhook']);

// SMS settings functions
lazy((): typeof import('./sms') => require('./sms'), [
  'saveSmsSettings',
  'updateSmsPerCheck',
  'getSmsSettings',
  'getSmsUsage',
  'sendTestSms',
  'bulkUpdateSmsPerCheck',
]);

// Check history and statistics functions
lazy((): typeof import('./history') => require('./history'), [
  'getCheckHistoryBigQuery',
  'getCheckStatsBigQuery',
  'getCheckStatsBatchBigQuery', // Batch stats for multiple websites (cost optimized)
  'getCheckReportMetrics',
  'getCheckHistoryForStats',
  'getCheckHistoryDailySummary',
]);

// Log notes
lazy((): typeof import('./log-notes') => require('./log-notes'), [
  'getLogNotes',
  'addLogNote',
  'updateLogNote',
  'deleteLogNote',
]);

// Manual logs
lazy((): typeof import('./manual-logs') => require('./manual-logs'), [
  'getManualLogs',
  'addManualLog',
]);

// API key management functions
lazy((): typeof import('./api-keys') => require('./api-keys'), [
  'createApiKey',
  'listApiKeys',
  'revokeApiKey',
  'deleteApiKey',
]);

// User management functions
lazy((): typeof import('./users') => require('./users'), [
  'getAllUsers',
  'deleteUser',
  'bulkDeleteUsers',
  'deleteUserAccount',
]);

// Organization management functions
lazy((): typeof import('./organizations') => require('./organizations'), ['updateOrganizationBillingProfile']);

// Team members (Pro): invites, roles, leaving
lazy((): typeof import('./team') => require('./team'), [
  'getTeamContext',
  'getTeam',
  'inviteTeamMember',
  'revokeTeamInvite',
  'acceptTeamInvite',
  'declineTeamInvite',
  'updateTeamMemberRole',
  'removeTeamMember',
  'leaveTeam',
]);

// Status pages
lazy((): typeof import('./status-pages') => require('./status-pages'), ['getStatusPageUptime', 'getStatusPageSnapshot', 'getStatusPageHeartbeat']);

// Public API
lazy((): typeof import('./public-api') => require('./public-api'), ['publicApi']);

// ---------------------------------------------------------------------------
// probe (see the probe repo, PLAN.md §6)
// ---------------------------------------------------------------------------
// probeGenerate answers probe's generator contract: given a launched product,
// return one severity-1 finding about its public surface, or 204. probeEvidence
// serves the public report the email links to.
lazy((): typeof import('./probe-generate') => require('./probe-generate'), ['probeGenerate', 'probeEvidence']);

// Remote MCP server + its OAuth 2.1 authorization server.
// Agent-native onboarding: see Docs/agent-onboarding.md
lazy((): typeof import('./mcp-server') => require('./mcp-server'), ['mcpServer']);
lazy((): typeof import('./mcp-oauth') => require('./mcp-oauth'), [
  'mcpOauth',
  'getMcpAuthorizationRequest',
  'approveMcpAuthorization',
  'listMcpConnections',
  'revokeMcpConnection',
]);
// Claim page callables for accounts an agent created (agent-signup.ts).
lazy((): typeof import('./agent-signup') => require('./agent-signup'), ['getAgentClaim', 'claimAgentAccount']);

// Badge endpoint (public, no auth)
lazy((): typeof import('./badge') => require('./badge'), ['badge']);

// Public marketing stats (total checks performed, for homepage counter)
lazy((): typeof import('./public-stats') => require('./public-stats'), ['getPublicChecksStats']);

// Public monitors (curated uptime landing pages on the marketing site)
lazy((): typeof import('./public-monitors') => require('./public-monitors'), [
  'getPublicMonitors',
  'getPublicMonitor',
]);

// Followed services: users follow a public monitor and get its down/up emails
lazy((): typeof import('./public-monitor-follows') => require('./public-monitor-follows'), [
  'followPublicMonitor',
  'unfollowPublicMonitor',
  'listPublicMonitorFollows',
]);

// Admin functions
lazy((): typeof import('./admin') => require('./admin'), [
  'getAdminStats',
  'getBigQueryUsage',
  'backfillDailySummariesAdmin',
  'getBadgeAnalytics',
  'investigateCheck',
]);

// System Notifications
lazy((): typeof import('./notifications') => require('./notifications'), [
  'createSystemNotification',
  'toggleSystemNotification',
  'deleteSystemNotification',
  'createUserNotification',
  'markNotificationAsRead',
  'markAllNotificationsAsRead',
  'deleteUserNotification',
]);

// Deploy Mode (global kill switch for deployments)
// Heartbeat-defer toggle co-exports from the same file — both are admin
// callables that flip system_settings/* docs the VPS listens to.
lazy((): typeof import('./deploy-mode') => require('./deploy-mode'), [
  'enableDeployMode',
  'disableDeployMode',
  'toggleHeartbeatDefer',
  'setEmailProvider',
]);

// Clerk webhook and email-platform contact sync (Resend + Day3)
lazy((): typeof import('./clerk-webhook') => require('./clerk-webhook'), [
  'clerkWebhook',
  'syncClerkUsersToResend',
  'syncSegmentsToResend',
  'resyncResendProperties',
  'backfillDay3Contacts',
]);

// Plan enforcement (downgrade handler)
lazy((): typeof import('./plan-enforcement') => require('./plan-enforcement'), ['enforcePlanDowngrade']);

// Tier recompute (admin callable — resyncs tier + subscribedPlanKey for every Clerk user)
lazy((): typeof import('./recompute-tiers') => require('./recompute-tiers'), ['recomputeAllTiers']);

// Domain Intelligence (DI) - Domain Expiry Monitoring
lazy((): typeof import('./domain-intelligence') => require('./domain-intelligence'), [
  'enableDomainExpiry', // Enable DI for a check (Nano only)
  'disableDomainExpiry', // Disable DI for a check
  'updateDomainExpiry', // Update DI settings (thresholds)
  'refreshDomainExpiry', // Manual refresh of RDAP data
  'bulkEnableDomainExpiry', // Bulk enable DI for multiple checks
  'getDomainIntelligence', // Get all DI data for user's checks
]);

// Onboarding survey responses (written to BigQuery)
lazy((): typeof import('./onboarding') => require('./onboarding'), [
  'submitOnboardingResponse',
  'getOnboardingResponses',
  'getOnboardingStatus',
  'deleteOnboardingResponses',
  'backfillOnboardingMetadata',
]);

// Activation lifecycle: fires user.first_incident_caught and
// the no-alert-channel notice, and keeps the activation contact properties current.
// getAlertCoverageReport answers "how many users can actually be alerted?".
lazy((): typeof import('./lifecycle') => require('./lifecycle'), [
  'runLifecycleSweep',
  'notifyUsersWithoutAlertChannel',
  'getAlertCoverageReport',
]);

// In-app feedback (emails connect@exit1.dev via Resend)
lazy((): typeof import('./feedback') => require('./feedback'), ['submitFeedback']);

// Inbound SMS on the Twilio number → forwarded to email via Resend
lazy((): typeof import('./twilio-inbound') => require('./twilio-inbound'), ['twilioInboundSms']);
