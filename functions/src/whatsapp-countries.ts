// Where we send WhatsApp alerts. WhatsApp fills the gap left by SMS
// (sms-countries.ts): South Africa, Brazil, Belgium, Japan and the rest of the
// world that SMS no longer reaches. Meta bills a utility template per delivered
// message by country, and the per-user SMS budget caps how many go out, so the
// only numbers we refuse are the ones Meta itself will not deliver to.
//
// Pure module: used by the save callable (reject) and by the alert paths that
// run on the VPS (skip).

import type { SmsSettings } from './types';

// Cuba, Iran, North Korea, Syria: countries the WhatsApp Business Platform
// does not serve.
const BLOCKED_PREFIXES = ['+53', '+98', '+850', '+963'];

export const WHATSAPP_BLOCKED_REGIONS_LABEL = 'Cuba, Iran, North Korea and Syria';

/** True when we send WhatsApp alerts to this E.164 number. */
export function isWhatsAppDestinationAllowed(phone: string): boolean {
  const p = phone.trim();
  if (!/^\+\d{8,15}$/.test(p)) return false;
  return !BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// WhatsApp numbers ride the SMS settings doc. Empty without a recorded opt-in,
// which Meta requires before any business-initiated message.
export function getWhatsAppRecipients(settings: SmsSettings): string[] {
  if (!settings.whatsappOptInAt) return [];
  return (settings.whatsappRecipients || []).filter(isWhatsAppDestinationAllowed);
}
