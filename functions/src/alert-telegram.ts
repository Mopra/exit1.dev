/**
 * Telegram alerts through our own bot. Free to send: no per-message price,
 * which is why it exists (SMS costs per text, see sms-countries.ts).
 *
 * A Telegram integration is a webhook with webhookType 'telegram'. Its url is
 * `https://t.me/<bot>?chat_id=<id>`: the chat id is the only per-user value,
 * and the bot token never leaves the server. Users get the chat id by opening
 * a one-time deep link (telegram-link.ts) and pressing Start in the bot.
 *
 * Runs in Cloud Functions (test sends, the link webhook) and on the VPS (real
 * alerts), so the token is read from the secret or from process.env.
 */
import { createHash } from "crypto";
import { TELEGRAM_BOT_TOKEN } from "./env";

/** Public username of the bot, without the @. */
export const TELEGRAM_BOT_USERNAME = "exit1_alerts_bot";

const TELEGRAM_API = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 10_000;
/** Telegram rejects messages over 4096 characters. */
const MAX_TEXT = 4000;

export function getTelegramBotToken(): string | undefined {
  let token: string | undefined;
  try {
    token = TELEGRAM_BOT_TOKEN.value();
  } catch {
    token = undefined;
  }
  token = (token || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  return token || undefined;
}

/**
 * The secret_token Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every
 * webhook call. Derived from the bot token (allowed chars: A-Z a-z 0-9 _ -).
 */
export function telegramWebhookSecret(token: string): string {
  return createHash("sha256").update(`exit1-telegram-webhook:${token}`).digest("hex");
}

export function buildTelegramUrl(chatId: string): string {
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?chat_id=${encodeURIComponent(chatId)}`;
}

/** Chat id from a stored integration url, or null when it is missing or malformed. */
export function extractTelegramChatId(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get("chat_id")?.trim();
    // Private chats are positive ids, groups and channels negative.
    return id && /^-?\d{1,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** A bold title, plain detail lines, and an optional link line. */
export function buildTelegramText(title: string, lines: string[], link?: { url: string; label: string }): string {
  const parts = [`<b>${escapeHtml(title)}</b>`, ...lines.map(escapeHtml)];
  if (link) parts.push("", `<a href="${escapeHtml(link.url).replace(/"/g, "&quot;")}">${escapeHtml(link.label)}</a>`);
  const text = parts.join("\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * Send one message. Throws `HTTP <status>: <description>` on failure so the
 * shared retry logic classifies it like any other webhook (a 403 "bot was
 * blocked by the user" is a 4xx and is not retried).
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = getTelegramBotToken();
  if (!token) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    let description = response.statusText;
    try {
      description = ((await response.json()) as { description?: string }).description || description;
    } catch {
      // Body was not JSON; keep the status text.
    }
    throw new Error(`HTTP ${response.status}: ${description}`);
  }
}

/** Send an alert to the chat a 'telegram' integration points at. */
export async function sendTelegramAlert(
  webhookUrl: string,
  title: string,
  lines: string[],
  link?: { url: string; label: string },
): Promise<void> {
  const chatId = extractTelegramChatId(webhookUrl);
  if (!chatId) throw new Error("Telegram integration is missing its chat. Reconnect it in Integrations.");
  await sendTelegramMessage(chatId, buildTelegramText(title, lines, link));
}
