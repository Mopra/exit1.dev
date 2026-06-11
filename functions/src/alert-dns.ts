import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent, DnsChange, EmailSettings } from "./types";
import { firestore } from "./init";
import { getEmailRecipientsForCheck, resolvePerFolder } from "./alert-helpers";
import { deliverEmailAlert, sendDnsChangeEmail } from "./alert-email";
import {
  PAGERDUTY_EVENTS_URL,
  buildPagerDutyEnvelope,
  extractPagerDutyRoutingKey,
  buildOpsgenieDelivery,
  getIncidentDedupKey,
  mapEventToPagerDuty,
  mapEventToOpsgenie,
} from "./alert-incident";
import {
  PUSHOVER_API_URL,
  buildPushoverFormBody,
  extractPushoverCredentials,
  mapEventToPushoverPriority,
} from "./alert-pushover";

interface DnsAlertPayload {
  event: WebhookEvent;
  checkId: string;
  checkName: string;
  domain: string;
  changes: DnsChange[];
  timestamp: number;
}

interface DnsResolutionFailedPayload {
  event: 'dns_resolution_failed';
  checkId: string;
  checkName: string;
  domain: string;
  error: string;
  timestamp: number;
}

export async function triggerDnsRecordAlert(
  check: Website,
  changes: DnsChange[],
): Promise<void> {
  const hasMissing = changes.some(c => c.changeType === 'missing');
  const event: WebhookEvent = hasMissing ? 'dns_record_missing' : 'dns_record_changed';

  const payload: DnsAlertPayload = {
    event,
    checkId: check.id,
    checkName: check.name,
    domain: check.url,
    changes,
    timestamp: Date.now(),
  };

  await dispatchDnsWebhooks(check.userId, event, payload, check.id);
  await dispatchDnsEmail(check, event, changes);

  logger.info(`DNS record alert sent for ${check.url}`, {
    checkId: check.id, event, changesCount: changes.length,
  });
}

/**
 * Email a DNS record-change alert to the check's recipients.
 *
 * DNS checks have no dedicated DNS event in the email-settings UI, so a
 * record-change email rides the check's existing `website_down` subscription —
 * i.e. if the user gets outage emails for this check, they also get DNS-change
 * emails. Gating precedence (perCheck > perFolder > checkFilter) mirrors the
 * status-alert email gate in alert.ts. Throttle/budget guards come from
 * deliverEmailAlert, keyed on the DNS event so they bucket separately from
 * outage emails.
 */
async function dispatchDnsEmail(
  check: Website,
  event: WebhookEvent,
  changes: DnsChange[],
): Promise<void> {
  try {
    const emailDoc = await firestore.collection('emailSettings').doc(check.userId).get();
    if (!emailDoc.exists) return;

    const emailSettings = emailDoc.data() as EmailSettings;
    const emailRecipients = getEmailRecipientsForCheck(emailSettings, check.id, check.folder);
    if (emailSettings.enabled === false || emailRecipients.length === 0) return;

    const GATE_EVENT: WebhookEvent = 'website_down';
    const globalAllows = (emailSettings.events || []).includes(GATE_EVENT);
    const perCheck = emailSettings.perCheck?.[check.id];
    const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
    const perCheckAllows = perCheck?.events ? perCheck.events.includes(GATE_EVENT) : undefined;
    const perFolder = !perCheck ? resolvePerFolder(emailSettings, check.folder) : undefined;
    const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
    const perFolderAllows = perFolder?.events ? perFolder.events.includes(GATE_EVENT) : undefined;
    const checkFilterMode = emailSettings.checkFilter?.mode;
    const defaultEventsAllow = emailSettings.checkFilter?.defaultEvents
      ? emailSettings.checkFilter.defaultEvents.includes(GATE_EVENT) : undefined;
    const shouldSend = perCheckEnabled === true
      ? (perCheckAllows ?? globalAllows)
      : perCheckEnabled === false ? false
      : perFolderEnabled === true
        ? (perFolderAllows ?? globalAllows)
        : perFolderEnabled === false ? false
        : checkFilterMode === 'all' ? (defaultEventsAllow ?? globalAllows)
        : false;
    if (!shouldSend) return;

    const emailFormat = emailSettings.emailFormat || 'html';
    await deliverEmailAlert({
      website: check,
      eventType: event,
      send: async () => {
        // Space sends to stay under Resend's 2 req/sec limit (matches alert.ts).
        for (let i = 0; i < emailRecipients.length; i++) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 600));
          await sendDnsChangeEmail(emailRecipients[i], check, changes, event, emailFormat);
        }
      },
    });
  } catch (err) {
    logger.error('Failed to dispatch DNS alert email', {
      checkId: check.id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function triggerDnsResolutionFailedAlert(
  check: Website,
  error: string,
): Promise<void> {
  const payload: DnsResolutionFailedPayload = {
    event: 'dns_resolution_failed',
    checkId: check.id,
    checkName: check.name,
    domain: check.url,
    error,
    timestamp: Date.now(),
  };

  await dispatchDnsWebhooks(check.userId, 'dns_resolution_failed', payload, check.id);

  logger.info(`DNS resolution failed alert sent for ${check.url}`, {
    checkId: check.id, error,
  });
}

async function dispatchDnsWebhooks(
  userId: string,
  event: WebhookEvent,
  payload: DnsAlertPayload | DnsResolutionFailedPayload,
  checkId: string,
): Promise<void> {
  try {
    const webhooksSnap = await firestore
      .collection('webhooks')
      .where('userId', '==', userId)
      .where('enabled', '==', true)
      .get();

    if (webhooksSnap.empty) return;

    for (const doc of webhooksSnap.docs) {
      const webhook = doc.data();
      const events: string[] = webhook.events ?? [];
      if (!events.includes(event)) continue;

      const filter = webhook.checkFilter;
      if (filter?.mode === 'include') {
        const matchesCheck = filter.checkIds?.includes(checkId);
        if (!matchesCheck) continue;
      }

      const formatted = formatDnsWebhookPayload(webhook.webhookType, webhook.url, payload);
      if (!formatted) {
        // Misconfigured (PagerDuty without routing_key, Pushover without token/user, etc.).
        // Per-platform message so the user knows what to fix.
        const lastError = webhook.webhookType === 'pagerduty'
          ? 'PagerDuty webhook URL is missing the routing_key query parameter'
          : webhook.webhookType === 'pushover'
          ? 'Pushover webhook URL is missing the token or user key'
          : `Webhook is missing required credentials for "${webhook.webhookType ?? 'generic'}"`;
        await firestore.collection('webhooks').doc(doc.id).update({
          lastDeliveryStatus: 'failed',
          lastError,
          lastErrorAt: Date.now(),
        });
        continue;
      }

      try {
        const contentType = formatted.contentType ?? 'application/json';
        const body = formatted.rawBody ?? JSON.stringify(formatted.body);
        // Preserve legacy behavior for everyone except Pushover: user-supplied
        // headers spread last and can override Content-Type if they want.
        // Pushover only accepts form-encoded, so we pin after the spread.
        const fetchHeaders: Record<string, string> = {
          'Content-Type': contentType,
          ...(webhook.headers ?? {}),
        };
        if (formatted.contentType === 'application/x-www-form-urlencoded') {
          fetchHeaders['Content-Type'] = formatted.contentType;
        }
        const response = await fetch(formatted.url, {
          method: 'POST',
          headers: fetchHeaders,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        await firestore.collection('webhooks').doc(doc.id).update({
          lastDeliveryStatus: response.ok ? 'success' : 'failed',
          lastDeliveryAt: Date.now(),
          ...(response.ok ? {} : { lastError: `HTTP ${response.status}`, lastErrorAt: Date.now() }),
        });
      } catch (err) {
        await firestore.collection('webhooks').doc(doc.id).update({
          lastDeliveryStatus: 'failed',
          lastError: err instanceof Error ? err.message : String(err),
          lastErrorAt: Date.now(),
        });
      }
    }
  } catch (err) {
    logger.error('Failed to dispatch DNS webhooks', { userId, error: err });
  }
}

interface FormattedDnsDelivery {
  url: string;
  body: unknown;
  // When set, the dispatcher sends `rawBody` as-is with the given contentType
  // instead of JSON.stringifying `body`. Used by Pushover (form-encoded).
  rawBody?: string;
  contentType?: string;
}

function formatDnsWebhookPayload(
  webhookType: string | undefined,
  webhookUrl: string,
  payload: DnsAlertPayload | DnsResolutionFailedPayload,
): FormattedDnsDelivery | null {
  if (webhookType === 'pushover') {
    const credentials = extractPushoverCredentials(webhookUrl);
    if (!credentials) return null;
    const title = payload.event === 'dns_resolution_failed'
      ? `DNS resolution failed — ${payload.domain}`
      : payload.event === 'dns_record_missing'
      ? `DNS records missing — ${payload.domain}`
      : `DNS records changed — ${payload.domain}`;
    let message: string;
    if ('changes' in payload) {
      message = payload.changes.map(c =>
        `${c.recordType} (${c.changeType}): ${c.previousValues.join(', ') || '(none)'} → ${c.newValues.join(', ') || '(none)'}`
      ).join('\n');
    } else {
      message = `Error: ${payload.error}`;
    }
    const priority = mapEventToPushoverPriority(payload.event, credentials.priority ?? 0);
    const form = buildPushoverFormBody({
      credentials,
      title,
      message,
      priority,
      timestampSec: Math.floor(payload.timestamp / 1000),
    });
    return {
      url: PUSHOVER_API_URL,
      body: form,
      rawBody: form.toString(),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  if (webhookType === 'pagerduty') {
    const routingKey = extractPagerDutyRoutingKey(webhookUrl);
    if (!routingKey) return null;
    const { action, severity } = mapEventToPagerDuty(payload.event);
    const summary = payload.event === 'dns_resolution_failed'
      ? `DNS resolution failed — ${payload.domain}`
      : payload.event === 'dns_record_missing'
      ? `DNS records missing — ${payload.domain}`
      : `DNS records changed — ${payload.domain}`;
    const details: Record<string, unknown> = {
      domain: payload.domain,
      check: payload.checkName,
    };
    if ('changes' in payload) {
      details.changes = payload.changes.map(c => ({
        record_type: c.recordType,
        change_type: c.changeType,
        previous: c.previousValues,
        next: c.newValues,
      }));
    } else {
      details.error = payload.error;
    }
    return {
      url: PAGERDUTY_EVENTS_URL,
      body: buildPagerDutyEnvelope({
        routingKey,
        eventAction: action,
        dedupKey: getIncidentDedupKey(payload.checkId, payload.event),
        summary,
        severity,
        source: payload.domain,
        timestamp: payload.timestamp,
        customDetails: details,
      }),
    };
  }
  if (webhookType === 'opsgenie') {
    const { priority, isResolve } = mapEventToOpsgenie(payload.event);
    const message = payload.event === 'dns_resolution_failed'
      ? `DNS resolution failed — ${payload.domain}`
      : payload.event === 'dns_record_missing'
      ? `DNS records missing — ${payload.domain}`
      : `DNS records changed — ${payload.domain}`;
    let description: string;
    if ('changes' in payload) {
      description = payload.changes.map(c =>
        `${c.recordType} (${c.changeType}): ${c.previousValues.join(', ') || '(none)'} → ${c.newValues.join(', ') || '(none)'}`
      ).join('\n');
    } else {
      description = `Error: ${payload.error}`;
    }
    const delivery = buildOpsgenieDelivery({
      baseUrl: webhookUrl,
      message,
      alias: getIncidentDedupKey(payload.checkId, payload.event),
      description,
      priority,
      source: 'exit1.dev',
      tags: ['exit1', 'dns'],
      details: { domain: payload.domain, check: payload.checkName },
      isResolve,
    });
    return { url: delivery.url, body: delivery.body };
  }

  const isPumble = webhookType === 'pumble' || webhookUrl.includes('api.pumble.com') || webhookUrl.includes('hooks.pumble.com');
  if (isPumble) return { url: webhookUrl, body: formatPumble(payload) };
  const isSlack = webhookType === 'slack' || webhookUrl.includes('hooks.slack.com');
  if (isSlack) return { url: webhookUrl, body: formatSlack(payload) };
  const isDiscord = webhookType === 'discord' || webhookUrl.includes('discord.com') || webhookUrl.includes('discordapp.com');
  if (isDiscord) return { url: webhookUrl, body: formatDiscord(payload) };
  return { url: webhookUrl, body: payload };
}

function formatPumble(payload: DnsAlertPayload | DnsResolutionFailedPayload): unknown {
  const emoji = payload.event === 'dns_resolution_failed' ? '❌' : '⚠️';
  const title = payload.event === 'dns_resolution_failed'
    ? `DNS Resolution Failed — ${payload.domain}`
    : `DNS Records Changed — ${payload.domain}`;

  let body: string;
  if ('changes' in payload) {
    body = payload.changes.map(c =>
      `${c.recordType} (${c.changeType}): ${c.previousValues.join(', ') || '(none)'} → ${c.newValues.join(', ') || '(none)'}`
    ).join('\n');
  } else {
    body = `Error: ${payload.error}`;
  }

  return { text: `${emoji} ${title}\n${body}` };
}

function formatSlack(payload: DnsAlertPayload | DnsResolutionFailedPayload): unknown {
  const emoji = payload.event === 'dns_resolution_failed' ? ':x:' : ':warning:';
  const title = payload.event === 'dns_resolution_failed'
    ? `DNS Resolution Failed — ${payload.domain}`
    : `DNS Records Changed — ${payload.domain}`;

  let body: string;
  if ('changes' in payload) {
    body = payload.changes.map(c =>
      `*${c.recordType}* (${c.changeType}): \`${c.previousValues.join(', ') || '(none)'}\` → \`${c.newValues.join(', ') || '(none)'}\``
    ).join('\n');
  } else {
    body = `Error: ${payload.error}`;
  }

  return {
    text: `${emoji} ${title}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${title}*\n${body}` } },
    ],
  };
}

function formatDiscord(payload: DnsAlertPayload | DnsResolutionFailedPayload): unknown {
  const title = payload.event === 'dns_resolution_failed'
    ? `DNS Resolution Failed — ${payload.domain}`
    : `DNS Records Changed — ${payload.domain}`;

  let description: string;
  if ('changes' in payload) {
    description = payload.changes.map(c =>
      `**${c.recordType}** (${c.changeType}): \`${c.previousValues.join(', ') || '(none)'}\` → \`${c.newValues.join(', ') || '(none)'}\``
    ).join('\n');
  } else {
    description = `Error: ${payload.error}`;
  }

  return {
    embeds: [{
      title,
      description,
      color: payload.event === 'dns_resolution_failed' ? 0xff0000 : 0xffa500,
      timestamp: new Date(payload.timestamp).toISOString(),
    }],
  };
}
