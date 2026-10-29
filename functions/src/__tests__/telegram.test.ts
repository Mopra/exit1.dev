import test from "node:test";
import assert from "node:assert/strict";

import { buildTelegramText, buildTelegramUrl, extractTelegramChatId, telegramWebhookSecret } from "../alert-telegram";
import { parseStartCode } from "../telegram-link";

test("chat id round-trips through the stored url, groups included", () => {
  assert.equal(extractTelegramChatId(buildTelegramUrl("123456789")), "123456789");
  assert.equal(extractTelegramChatId(buildTelegramUrl("-1001234567890")), "-1001234567890");
});

test("a url without a numeric chat id is rejected", () => {
  assert.equal(extractTelegramChatId("https://t.me/exit1_alerts_bot"), null);
  assert.equal(extractTelegramChatId("https://t.me/exit1_alerts_bot?chat_id=@someone"), null);
  assert.equal(extractTelegramChatId("not a url"), null);
});

test("message text escapes HTML from check names and errors", () => {
  const text = buildTelegramText("🚨 <script> & co is DOWN", ["Error: a<b"], { url: "https://app.exit1.dev/logs?check=a&b", label: "Go" });
  assert.match(text, /^<b>🚨 &lt;script&gt; &amp; co is DOWN<\/b>/);
  assert.match(text, /Error: a&lt;b/);
  assert.match(text, /href="https:\/\/app\.exit1\.dev\/logs\?check=a&amp;b"/);
});

test("very long messages are cut under Telegram's limit", () => {
  assert.ok(buildTelegramText("t", ["x".repeat(5000)]).length <= 4001);
});

test("start codes parse in private chats and groups", () => {
  assert.equal(parseStartCode("/start abc_DEF-123"), "abc_DEF-123");
  assert.equal(parseStartCode("/start@exit1_alerts_bot abc"), "abc");
  assert.equal(parseStartCode("/start"), null);
  assert.equal(parseStartCode("hello"), undefined);
  assert.equal(parseStartCode("/start a b"), undefined);
  assert.equal(parseStartCode(undefined), undefined);
});

test("webhook secret uses only characters Telegram allows", () => {
  assert.match(telegramWebhookSecret("123:ABC"), /^[A-Za-z0-9_-]{1,256}$/);
});
