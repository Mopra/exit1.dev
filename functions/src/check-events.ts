import * as logger from "firebase-functions/logger";
import { Resend } from "resend";
import { createCheckHistoryRecord } from "./check-utils";
import { insertCheckHistory } from "./bigquery";
import { firestore } from "./init";
import { getResendCredentials, RESEND_API_KEY, RESEND_FROM } from "./env";
import { EmailSettings, Website } from "./types";

// Re-export secrets for consumers that need them
export { RESEND_API_KEY, RESEND_FROM };

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

/**
 * Handle check disabled event - records history to BigQuery and sends notification email.
 * 
 * This is called directly from the code that disables checks (scheduler auto-disable and
 * manual toggleCheckStatus), rather than using a Firestore trigger. This eliminates
 * ~170K+ wasted trigger invocations per day from non-disable check updates.
 * 
 * @param website - The website/check that was disabled (must include id and userId)
 * @param disabledReason - The reason the check was disabled
 * @param disabledAt - Timestamp when the check was disabled (defaults to now)
 */
export const handleCheckDisabled = async (
  website: Website,
  disabledReason: string,
  disabledAt?: number
): Promise<void> => {
  const checkId = website.id;
  const effectiveDisabledAt = disabledAt ?? Date.now();
  const effectiveReason = disabledReason.trim() || "Check disabled";

  if (!website.userId) {
    logger.warn("Skipping disabled history record: missing userId", { checkId });
    return;
  }

  const record = createCheckHistoryRecord(website, {
    status: "disabled",
    error: effectiveReason,
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

  // Record history to BigQuery
  try {
    await insertCheckHistory(record);
    // Note: We don't flush here - the caller should flush when appropriate
    // (e.g., at the end of a scheduler run or after the toggle operation)
  } catch (error) {
    logger.error("Failed to record disabled check history", {
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Send notification email
  try {
    await sendDisabledEmail(website, effectiveReason, effectiveDisabledAt);
  } catch (error) {
    logger.error("Failed to send disabled check email", {
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// DEPRECATED: The Firestore trigger has been replaced with direct calls to handleCheckDisabled.
// This eliminates ~170K+ wasted trigger invocations per day from non-disable check updates.
// Keeping this code commented for reference in case we need to restore it:
//
// export const logCheckDisabled = onDocumentUpdated(
//   { document: "checks/{checkId}", secrets: [RESEND_API_KEY, RESEND_FROM] },
//   async (event) => {
//     const before = event.data?.before.data();
//     const after = event.data?.after.data();
//     if (!before || !after) return;
//     const wasDisabled = before.disabled === true;
//     const isDisabled = after.disabled === true;
//     if (wasDisabled || !isDisabled) return;
//     const website: Website = { ...(after as Website), id: event.params.checkId };
//     const disabledReason = after.disabledReason?.trim() || "Check disabled";
//     const disabledAt = after.disabledAt ?? Date.now();
//     await handleCheckDisabled(website, disabledReason, disabledAt);
//   }
// );
