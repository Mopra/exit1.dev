import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent, DnsChange } from "./types";
import { firestore } from "./init";

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

      const formatted = formatDnsWebhookPayload(webhook.webhookType, payload);

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(webhook.headers ?? {}),
          },
          body: JSON.stringify(formatted),
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
  payload: DnsAlertPayload | DnsResolutionFailedPayload,
): unknown {
  if (webhookType === 'slack') return formatSlack(payload);
  if (webhookType === 'discord') return formatDiscord(payload);
  return payload;
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
