/**
 * Connecting a Telegram chat to an exit1 account.
 *
 * 1. The integration form calls createTelegramLink: we store a one-time code
 *    in `telegramLinks/{code}` (15 min) and hand back
 *    `https://t.me/<bot>?start=<code>`.
 * 2. The user opens it and presses Start (or adds the bot to a group with that
 *    link). Telegram posts `/start <code>` to telegramWebhook, which records the
 *    chat on the link doc and replies in the chat.
 * 3. The form polls getTelegramLink until the chat shows up, then saves an
 *    ordinary webhook integration with webhookType 'telegram'.
 *
 * The bot only ever answers /start; it reads nothing else. The webhook is
 * registered once with setWebhook and secret_token = telegramWebhookSecret(token).
 */
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { randomBytes, timingSafeEqual } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { firestore } from "./init";
import { resolveAccountId } from "./team-access";
import { TELEGRAM_BOT_TOKEN } from "./env";
import {
  TELEGRAM_BOT_USERNAME,
  buildTelegramUrl,
  extractTelegramChatId,
  getTelegramBotToken,
  sendTelegramMessage,
  telegramWebhookSecret,
} from "./alert-telegram";

const toMs = (t: Date | Timestamp) => (t instanceof Date ? t.getTime() : t.toMillis());

const LINK_TTL_MS = 15 * 60 * 1000;
const LINKS = "telegramLinks";
const CHATS = "telegramChats";

interface TelegramLinkDoc {
  userId: string;
  createdAt: number;
  /** A Firestore TTL policy on this field deletes old links. */
  expiresAt: Date | Timestamp;
  chatId?: string;
  chatTitle?: string;
  linkedAt?: number;
}

/**
 * Throws unless `url` points at a chat this account linked through the bot.
 * Without it anyone could save another person's chat id and have our bot
 * message them.
 */
export async function assertTelegramChatLinked(userId: string, url: string): Promise<void> {
  const chatId = extractTelegramChatId(url);
  if (!chatId) throw new HttpsError("invalid-argument", "Telegram integration is missing its chat. Connect it again.");
  const snap = await firestore.collection(CHATS).doc(`${userId}_${chatId}`).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "Connect this Telegram chat through the bot first.");
}

export const createTelegramLink = onCall(async (request) => {
  const uid = await resolveAccountId(request, "write");
  // Telegram's start parameter allows up to 64 chars of A-Z a-z 0-9 _ -.
  const code = randomBytes(18).toString("base64url");
  const now = Date.now();
  const doc: TelegramLinkDoc = { userId: uid, createdAt: now, expiresAt: new Date(now + LINK_TTL_MS) };
  await firestore.collection(LINKS).doc(code).set(doc);
  return {
    code,
    url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${code}`,
    // Telegram asks which group to add the bot to, then sends /start@bot <code> there.
    groupUrl: `https://t.me/${TELEGRAM_BOT_USERNAME}?startgroup=${code}`,
    expiresAt: now + LINK_TTL_MS,
  };
});

export const getTelegramLink = onCall(async (request) => {
  const uid = await resolveAccountId(request, "write");
  const code = typeof request.data?.code === "string" ? request.data.code : "";
  if (!code || code.length > 64) throw new HttpsError("invalid-argument", "Link code required");

  const snap = await firestore.collection(LINKS).doc(code).get();
  const data = snap.data() as TelegramLinkDoc | undefined;
  if (!data || data.userId !== uid) throw new HttpsError("not-found", "Link not found");
  if (!data.chatId) {
    return { linked: false, expired: toMs(data.expiresAt) < Date.now() };
  }
  return { linked: true, chatTitle: data.chatTitle ?? null, url: buildTelegramUrl(data.chatId) };
});

type TelegramChat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
type TelegramUpdate = { message?: { text?: string; chat?: TelegramChat } };

/** `/start <code>` or, in groups, `/start@bot <code>`. */
export function parseStartCode(text: string | undefined): string | null | undefined {
  if (!text) return undefined;
  const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text.trim());
  if (!m) return undefined;
  return m[1] ?? null;
}

function chatTitle(chat: TelegramChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return name || (chat.username ? `@${chat.username}` : "Telegram chat");
}

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const telegramWebhook = onRequest({ secrets: [TELEGRAM_BOT_TOKEN], maxInstances: 2 }, async (req, res) => {
  const token = getTelegramBotToken();
  const given = req.get("x-telegram-bot-api-secret-token") ?? "";
  if (!token || req.method !== "POST" || !sameSecret(given, telegramWebhookSecret(token))) {
    res.status(403).send("forbidden");
    return;
  }

  // Always 200 once authenticated: Telegram retries anything else, and a
  // retried /start would only reply twice.
  try {
    const update = req.body as TelegramUpdate;
    const chat = update.message?.chat;
    const code = parseStartCode(update.message?.text);
    if (!chat || code === undefined) {
      res.status(200).send("ok");
      return;
    }
    const chatId = String(chat.id);

    if (code === null) {
      await sendTelegramMessage(chatId,
        "This bot sends exit1.dev monitoring alerts.\n\nTo connect it, open <b>Integrations</b> in the exit1.dev app, add a Telegram integration and follow the link it gives you.");
      res.status(200).send("ok");
      return;
    }

    const ref = firestore.collection(LINKS).doc(code);
    const outcome = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() as TelegramLinkDoc | undefined;
      if (!data || toMs(data.expiresAt) < Date.now()) return "expired";
      if (data.chatId && data.chatId !== chatId) return "used";
      tx.update(ref, { chatId, chatTitle: chatTitle(chat), linkedAt: Date.now() });
      // Permanent proof that this account owns the chat; saving an integration requires it.
      tx.set(firestore.collection(CHATS).doc(`${data.userId}_${chatId}`), {
        userId: data.userId, chatId, chatTitle: chatTitle(chat), linkedAt: Date.now(),
      });
      return "linked";
    });

    const reply = outcome === "linked"
      ? "✅ Connected to exit1.dev. Go back to the app to finish setting up the integration."
      : outcome === "used"
      ? "This link was already used for another chat. Create a new one in the exit1.dev app."
      : "This link has expired. Create a new one in the exit1.dev app (Integrations, Telegram).";
    await sendTelegramMessage(chatId, reply);
  } catch (error) {
    logger.error("telegramWebhook: update failed", { error: error instanceof Error ? error.message : String(error) });
  }
  res.status(200).send("ok");
});
