// ============================================================================
// SLA REPORT UNSUBSCRIBE (public HTTPS function `slaReportUnsubscribe`)
//
// GET shows a confirm page (link scanners prefetch GETs, so a GET must never
// unsubscribe), POST applies. The link carries ?r=reportId&e=email&t=token,
// where the token is an HMAC over both (sla-unsubscribe-token.ts), so a
// forwarded email can only unsubscribe the address it was sent to.
// ============================================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "./init";
import { SLA_UNSUBSCRIBE_SECRET, getSlaUnsubscribeSecret } from "./env";
import { normalizeEmail } from "./email-suppression-policy";
import { escapeHtml } from "./sla-email-html";
import { verifySlaUnsubscribe } from "./sla-unsubscribe-token";
import { SLA_REPORTS_COLLECTION, type SlaReportDoc } from "./sla-types";

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:480px;margin:48px auto;background:#fff;border-radius:8px;padding:32px">
<h1 style="font-size:20px;margin:0 0 12px 0">${escapeHtml(title)}</h1>${body}
<p style="margin:24px 0 0 0;font-size:12px;color:#4b5563">exit1.dev</p></div></body></html>`;
}

const param = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

export const slaReportUnsubscribe = onRequest(
  { memory: "256MiB", timeoutSeconds: 30, maxInstances: 5, secrets: [SLA_UNSUBSCRIBE_SECRET] },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "text/html; charset=utf-8");
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).send(page("Not allowed", ""));
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const reportId = param(req.query.r) || param(body.r);
    const email = normalizeEmail(param(req.query.e) || param(body.e));
    const token = param(req.query.t) || param(body.t);
    const secret = getSlaUnsubscribeSecret();

    if (!secret || !/^[a-zA-Z0-9_-]{1,128}$/.test(reportId) || !email || !verifySlaUnsubscribe(secret, reportId, email, token)) {
      res.status(400).send(page("This link is not valid", `<p style="font-size:14px">The unsubscribe link is incomplete or has expired. Ask the sender to remove you from the report.</p>`));
      return;
    }

    const ref = firestore.collection(SLA_REPORTS_COLLECTION).doc(reportId);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(200).send(page("You are unsubscribed", `<p style="font-size:14px">This report no longer exists, so you will not get it again.</p>`));
      return;
    }
    const report = snap.data() as SlaReportDoc;

    if (req.method === "GET") {
      res.status(200).send(page(
        "Unsubscribe from this report?",
        `<p style="font-size:14px">${escapeHtml(email)} will stop getting the monthly SLA report "${escapeHtml(report.name)}".</p>
<form method="POST"><input type="hidden" name="r" value="${escapeHtml(reportId)}"><input type="hidden" name="e" value="${escapeHtml(email)}"><input type="hidden" name="t" value="${escapeHtml(token)}">
<button type="submit" style="background:#111827;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;cursor:pointer">Unsubscribe</button></form>`,
      ));
      return;
    }

    await ref.update({ unsubscribed: FieldValue.arrayUnion(email) });
    logger.info("[sla] recipient unsubscribed", { reportId });
    res.status(200).send(page("You are unsubscribed", `<p style="font-size:14px">${escapeHtml(email)} will not get "${escapeHtml(report.name)}" again.</p>`));
  },
);
