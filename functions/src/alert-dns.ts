import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent, DnsChange } from "./types";
import { firestore } from "./init";
import {
  PAGERDUTY_EVENTS_URL,
  buildPagerDutyEnvelope,
  extractPagerDutyRoutingKey,
  buildOpsgenieDelivery,
  getIncidentDedupKey,
  mapEventToPagerDuty,
  mapEventToOpsgenie,
} from "./alert-incident";

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

  logger.info(`DNS record alert sent for ${check.url}`, {
    checkId: check.id, event, changesCount: changes.length,
  });
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
        // Misconfigured (e.g. PagerDuty without routing_key) — surface and skip
        await firestore.collection('webhooks').doc(doc.id).update({
          lastDeliveryStatus: 'failed',
          lastError: 'PagerDuty webhook URL is missing the routing_key query parameter',
          lastErrorAt: Date.now(),
        });
        continue;
      }

      try {
        const response = await fetch(formatted.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(webhook.headers ?? {}),
          },
          body: JSON.stringify(formatted.body),
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

function formatDnsWebhookPayload(
  webhookType: string | undefined,
  webhookUrl: string,
  payload: DnsAlertPayload | DnsResolutionFailedPayload,
): { url: string; body: unknown } | null {
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
