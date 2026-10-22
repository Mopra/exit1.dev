import test from "node:test";
import assert from "node:assert/strict";

import { isWhatsAppDestinationAllowed, getWhatsAppRecipients } from "../whatsapp-countries";
import { buildStatusWhatsAppTemplate, buildSslWhatsAppTemplate, normalizeTemplateParam } from "../alert-whatsapp";
import type { SmsSettings, Website } from "../types";

test("allows the countries SMS no longer reaches", () => {
  for (const n of ["+27821234525", "+5511912345678", "+32470123456", "+81701234509", "+16505550122", "+4520123456"]) {
    assert.equal(isWhatsAppDestinationAllowed(n), true, n);
  }
});

test("blocks countries Meta does not serve and malformed numbers", () => {
  for (const n of ["+5351234567", "+989121234567", "+85021234567", "+963931234567", "27821234525", "+12"]) {
    assert.equal(isWhatsAppDestinationAllowed(n), false, n);
  }
});

test("no recipients without a recorded opt-in", () => {
  const base = { userId: "u", enabled: true, events: [], createdAt: 0, updatedAt: 0 } as unknown as SmsSettings;
  assert.deepEqual(getWhatsAppRecipients({ ...base, whatsappRecipients: ["+27821234525"] }), []);
  assert.deepEqual(
    getWhatsAppRecipients({ ...base, whatsappRecipients: ["+27821234525", "+5351234567"], whatsappOptInAt: 1 }),
    ["+27821234525"],
  );
});

test("template params never hold newlines, runs of spaces or empty text", () => {
  assert.equal(normalizeTemplateParam("a\n\tb     c"), "a b c");
  assert.equal(normalizeTemplateParam(""), "-");
  assert.equal(normalizeTemplateParam(undefined), "-");
  assert.equal(normalizeTemplateParam("x".repeat(300), 10).length, 10);
});

const site = { id: "c1", userId: "u", name: "Shop\nAPI", url: "https://shop.example", lastStatusCode: 503 } as unknown as Website;

test("down and up pick their templates and fill name, status, url", () => {
  const down = buildStatusWhatsAppTemplate(site, "website_down");
  assert.equal(down.name, "exit1_check_down");
  assert.equal(down.params.length, 3);
  assert.equal(down.params[0], "Shop API");
  assert.equal(down.params[2], "https://shop.example");

  const up = buildStatusWhatsAppTemplate({ ...site, lastStatusCode: 200, responseTime: 120 } as Website, "website_up", "offline");
  assert.equal(up.name, "exit1_check_up");
  assert.match(up.params[1], /was offline/);
  assert.match(up.params[1], /120ms/);
});

test("ssl template carries the expiry", () => {
  const t = buildSslWhatsAppTemplate(site, "ssl_warning", { valid: true, daysUntilExpiry: 7 });
  assert.equal(t.name, "exit1_ssl_alert");
  assert.equal(t.params[1], "expires in 7 days");
});
