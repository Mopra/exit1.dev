// Where we send SMS. Price per text varies 100x by destination (US ~$0.001,
// South Africa ~$0.135), and one far-away number was a third of the Twilio bill.
// So texts only go to the US, Canada and Europe. Everything else uses free
// channels (email, Pushover, Slack, Discord, webhooks).
//
// Senders: the US toll-free number covers the US and Canada, and the "Exit1"
// sender name covers Europe. There is no number for countries that refuse a
// sender name, so Belgium (+32) and Japan (+81) are out; the Danish number
// that used to cover them was released on 2026-10-22 ($15/month).
//
// Pure module: used by the save callable (reject) and by the alert paths that
// run on the VPS (skip), so a number saved before this rule existed goes quiet
// instead of being billed.

// The EU member states except Belgium, plus the UK, Norway, Iceland,
// Liechtenstein and Switzerland.
const ALLOWED_PREFIXES = [
  '+30', '+31', '+33', '+34', '+36', '+39', '+40', '+41', '+43',
  '+44', '+45', '+46', '+47', '+48', '+49',
  '+351', '+352', '+353', '+354', '+356', '+357', '+358', '+359',
  '+370', '+371', '+372', '+385', '+386', '+420', '+421', '+423',
];

// +1 is shared by the US, Canada and the Caribbean. These area codes are the
// Caribbean and Bermuda, which bill at international rates.
const NANP_BLOCKED_AREA_CODES = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658',
  '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);

export const SMS_ALLOWED_REGIONS_LABEL = 'the US, Canada, the UK and the EU (except Belgium)';

/** True when we send SMS to this E.164 number. */
export function isSmsDestinationAllowed(phone: string): boolean {
  const p = phone.trim();
  if (/^\+1\d{10}$/.test(p)) {
    return !NANP_BLOCKED_AREA_CODES.has(p.slice(2, 5));
  }
  return ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}
