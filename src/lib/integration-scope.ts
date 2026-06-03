// Webhooks vs Integrations: same Firestore collection, two UI views.
// "Webhook" = user pasted an endpoint URL we POST to (generic, Slack, Discord,
// Teams, Pumble). "Integration" = user gave us API credentials and we POST to
// a fixed third-party API (Pushover, PagerDuty, Opsgenie). Splitting the UI
// leaves room for OAuth-based integrations later without forcing the URL form
// shape onto them.

export type WebhookPlatformType =
  | 'slack'
  | 'discord'
  | 'teams'
  | 'pumble'
  | 'pagerduty'
  | 'opsgenie'
  | 'pushover'
  | 'generic';

export type IntegrationScope = 'webhook' | 'integration';

export const WEBHOOK_SCOPE_TYPES = [
  'generic',
  'slack',
  'discord',
  'teams',
  'pumble',
] as const satisfies readonly WebhookPlatformType[];

export const INTEGRATION_SCOPE_TYPES = [
  'pushover',
  'pagerduty',
  'opsgenie',
] as const satisfies readonly WebhookPlatformType[];

const INTEGRATION_SCOPE_SET = new Set<WebhookPlatformType>(INTEGRATION_SCOPE_TYPES);

export function scopeOfWebhookType(
  webhookType: WebhookPlatformType | string | undefined,
): IntegrationScope {
  const t = (webhookType || 'generic') as WebhookPlatformType;
  return INTEGRATION_SCOPE_SET.has(t) ? 'integration' : 'webhook';
}

export function platformTypesForScope(scope: IntegrationScope): readonly WebhookPlatformType[] {
  return scope === 'webhook' ? WEBHOOK_SCOPE_TYPES : INTEGRATION_SCOPE_TYPES;
}

export function defaultPlatformForScope(scope: IntegrationScope): WebhookPlatformType {
  return scope === 'webhook' ? 'generic' : 'pushover';
}

interface ScopeLabels {
  title: string;                  // "Webhooks" / "Integrations"
  titleSingular: string;          // "webhook" / "integration"
  titlePlural: string;            // "webhooks" / "integrations"
  description: string;            // page subtitle
  addButton: string;              // "Add Webhook" / "Add Integration"
  searchPlaceholder: string;
  settingsCardTitle: string;
  settingsCardDescription: string;
  infoCardTitle: string;
  formIconLabel: string;
  formNewTitle: string;
  formEditTitle: string;
  formNewSubtitle: string;
  formEditSubtitle: string;
  testMenu: string;               // "Test webhook" / "Test integration"
  emptyTitle: string;
  emptyDescription: string;
  emptyAction: string;
  bulkItemLabel: string;
  deleteSingleTitle: (name: string) => string;
  deleteBulkTitle: (n: number) => string;
  failureEmailSubject: string;
  crossLinkLabel: string;         // "Looking for Slack/Discord/etc? See Webhooks →"
  crossLinkPath: string;
  upgradeLimitMessage: (max: number) => string;
  downgradeMessage: string;
}

const WEBHOOK_LABELS: ScopeLabels = {
  title: 'Webhooks',
  titleSingular: 'webhook',
  titlePlural: 'webhooks',
  description: 'POST monitoring events to any endpoint URL you own.',
  addButton: 'Add Webhook',
  searchPlaceholder: 'Search webhooks...',
  settingsCardTitle: 'Webhook Settings',
  settingsCardDescription: 'Configure which events trigger webhook notifications for your endpoints.',
  infoCardTitle: 'How webhooks fire',
  formIconLabel: 'Webhook',
  formNewTitle: 'New Webhook',
  formEditTitle: 'Edit Webhook',
  formNewSubtitle: 'Send alerts to any endpoint',
  formEditSubtitle: 'Update your webhook configuration',
  testMenu: 'Test webhook',
  emptyTitle: 'No webhooks configured',
  emptyDescription: 'Add your first webhook to start receiving instant notifications when your websites change status.',
  emptyAction: 'Add Your First Webhook',
  bulkItemLabel: 'webhook',
  deleteSingleTitle: (name) => `Delete "${name}"?`,
  deleteBulkTitle: (n) => `Delete ${n} webhook${n !== 1 ? 's' : ''}?`,
  failureEmailSubject: 'Webhook',
  crossLinkLabel: 'Looking for Pushover, PagerDuty, or Opsgenie? Find them under Integrations →',
  crossLinkPath: '/integrations',
  upgradeLimitMessage: (max) => `You've reached the free plan limit of ${max} alert channel${max === 1 ? '' : 's'} (webhooks and integrations combined). Upgrade to Nano for up to 50.`,
  downgradeMessage: 'Your webhooks were disabled after downgrading. You can re-enable up to 1 across webhooks and integrations on the Free plan.',
};

const INTEGRATION_LABELS: ScopeLabels = {
  title: 'Integrations',
  titleSingular: 'integration',
  titlePlural: 'integrations',
  description: 'Connect push notifications and incident-management tools to your monitoring.',
  addButton: 'Add Integration',
  searchPlaceholder: 'Search integrations...',
  settingsCardTitle: 'Integration Settings',
  settingsCardDescription: 'Configure which events trigger alerts in your connected services.',
  infoCardTitle: 'How integrations fire',
  formIconLabel: 'Integration',
  formNewTitle: 'New Integration',
  formEditTitle: 'Edit Integration',
  formNewSubtitle: 'Connect a third-party service',
  formEditSubtitle: 'Update your integration configuration',
  testMenu: 'Test integration',
  emptyTitle: 'No integrations configured',
  emptyDescription: 'Connect Pushover, PagerDuty, or Opsgenie to receive alerts on the tools your team already uses.',
  emptyAction: 'Add Your First Integration',
  bulkItemLabel: 'integration',
  deleteSingleTitle: (name) => `Delete "${name}"?`,
  deleteBulkTitle: (n) => `Delete ${n} integration${n !== 1 ? 's' : ''}?`,
  failureEmailSubject: 'Integration',
  crossLinkLabel: 'Looking for Slack, Discord, Teams, or a generic webhook? Find them under Webhooks →',
  crossLinkPath: '/webhooks',
  upgradeLimitMessage: (max) => `You've reached the free plan limit of ${max} alert channel${max === 1 ? '' : 's'} (webhooks and integrations combined). Upgrade to Nano for up to 50.`,
  downgradeMessage: 'Your integrations were disabled after downgrading. You can re-enable up to 1 across webhooks and integrations on the Free plan.',
};

export function labelsForScope(scope: IntegrationScope): ScopeLabels {
  return scope === 'webhook' ? WEBHOOK_LABELS : INTEGRATION_LABELS;
}
