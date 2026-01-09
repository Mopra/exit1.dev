import * as logger from "firebase-functions/logger";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { Resend } from "resend";
import { createCheckHistoryRecord } from "./check-utils";
import { insertCheckHistory, flushBigQueryInserts } from "./bigquery";
import { firestore } from "./init";
import { getResendCredentials, RESEND_API_KEY, RESEND_FROM } from "./env";
import { EmailSettings, Website } from "./types";

const resolveDisabledEmailRecipient = async (website: Website): Promise<string | null> => {
  const settingsSnap = await firestore.collection("emailSettings").doc(website.userId).get();
  if (!settingsSnap.exists) {
    return null;
  }

  const settings = settingsSnap.data() as EmailSettings;
  if (settings.enabled === false) {
    return null;
  }

  const recipient = typeof settings.recipient === "string" ? settings.recipient.trim() : "";
  if (!recipient) {
    return null;
  }

  const perCheck = settings.perCheck?.[website.id];
  if (perCheck?.enabled === false) {
    return null;
  }

  return recipient;
};

const buildDisabledEmail = (website: Website, disabledReason: string, disabledAt: number) => {
  const baseUrl = process.env.FRONTEND_URL || "https://app.exit1.dev";
  const subject = `Check disabled: ${website.name}`;
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">Check disabled</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date(disabledAt).toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.2)">
          <div><strong>Name:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>Reason:</strong> ${disabledReason}</div>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">
          You can re-enable this check in the dashboard: <a href="${baseUrl}/checks" style="color:#38bdf8">Open checks</a>
        </p>
      </div>
    </div>
  `;

  return { subject, html };
};

const sendDisabledEmail = async (website: Website, disabledReason: string, disabledAt: number) => {
  const recipient = await resolveDisabledEmailRecipient(website);
  if (!recipient) {
    logger.info("Skipping disabled email: no recipient configured", {
      checkId: website.id,
      userId: website.userId,
    });
    return;
  }

  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    logger.warn("Skipping disabled email: RESEND_API_KEY not configured", {
      checkId: website.id,
      userId: website.userId,
    });
    return;
  }

  const { subject, html } = buildDisabledEmail(website, disabledReason, disabledAt);
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from: fromAddress,
    to: recipient,
    subject,
    html,
  });
};

export const logCheckDisabled = onDocumentUpdated(
  { document: "checks/{checkId}", secrets: [RESEND_API_KEY, RESEND_FROM] },
  async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();

  if (!before || !after) {
    return;
  }

  const wasDisabled = before.disabled === true;
  const isDisabled = after.disabled === true;

  if (wasDisabled || !isDisabled) {
    return;
  }

  const website: Website = { ...(after as Website), id: event.params.checkId };
  if (!website.userId) {
    logger.warn("Skipping disabled history record: missing userId", { checkId: event.params.checkId });
    return;
  }

  const disabledReason =
    typeof after.disabledReason === "string" && after.disabledReason.trim().length > 0
      ? after.disabledReason.trim()
      : "Check disabled";
  const disabledAt = typeof after.disabledAt === "number" ? after.disabledAt : Date.now();

  const record = createCheckHistoryRecord(website, {
    status: "disabled",
    error: disabledReason,
    targetHostname: website.targetHostname,
    targetIp: website.targetIp,
    targetIpsJson: website.targetIpsJson,
    targetIpFamily: website.targetIpFamily,
    targetCountry: website.targetCountry,
    targetRegion: website.targetRegion,
    targetCity: website.targetCity,
    targetLatitude: website.targetLatitude,
    targetLongitude: website.targetLongitude,
    targetAsn: website.targetAsn,
    targetOrg: website.targetOrg,
    targetIsp: website.targetIsp,
  });

  try {
    await insertCheckHistory(record);
    await flushBigQueryInserts();
  } catch (error) {
    logger.error("Failed to record disabled check history", {
      checkId: event.params.checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await sendDisabledEmail(website, disabledReason, disabledAt);
  } catch (error) {
    logger.error("Failed to send disabled check email", {
      checkId: event.params.checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
