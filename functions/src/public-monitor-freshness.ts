import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website, WebhookEvent } from "./types";
import { publicCurrentStatus } from "./public-monitor-blocked";

/**
 * Push a public monitor's status change out the moment it happens, instead of
 * waiting for the hourly refresh in public-monitors.ts.
 *
 * During the 2026-10-21 PECL outage people (and the LLMs answering "is pecl
 * down" for them) read exit1.dev/status/pecl.php.net, which sits behind an
 * hourly page doc, CDN and ISR. A status page that still says "up" an hour
 * into an outage is the one result nobody should cite. So on each transition:
 *
 *   1. patch public_monitor_pages/{slug} with the new status and statusChangedAt/To
 *   2. ask exit1.dev to re-render the page (it verifies the change itself)
 *   3. ping IndexNow so Bing (and the ChatGPT/Copilot search built on it) recrawls
 *
 * Runs on the VPS, fire-and-forget from triggerAlert. Never throws.
 */

const PAGES = "public_monitor_pages";
const SITE_URL = "https://exit1.dev";

/** Public key; the website serves it at /<key>.txt to prove ownership. */
const INDEXNOW_KEY = "4c519d6c74b9c48e92f1f76f66e520b5";

const TIMEOUT_MS = 5000;

async function post(url: string, body: unknown): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  return res.status;
}

export async function pushPublicMonitorTransition(website: Website, eventType: WebhookEvent): Promise<void> {
  if (eventType !== "website_down" && eventType !== "website_up") return;
  try {
    const snap = await firestore.collection(PAGES).where("checkId", "==", website.id).limit(1).get();
    if (snap.empty) return;
    const doc = snap.docs[0];
    const slug = doc.id;

    const status = publicCurrentStatus(eventType === "website_down" ? "offline" : "online", website.lastError);
    // triggerAlert is re-driven for one transition (retries, pending states).
    // Only the first call moves statusChangedAt, or "down since" drifts later
    // with every retry, and only it pings the site and IndexNow.
    const changed = await firestore.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (fresh.get("statusChangedTo") === status && fresh.get("status") === status) return false;
      const now = Date.now();
      tx.update(doc.ref, { status, lastChecked: now, statusChangedAt: now, statusChangedTo: status });
      return true;
    });
    if (!changed) return;

    const pageUrl = `${SITE_URL}/status/${slug}`;
    const [refresh, indexNow] = await Promise.allSettled([
      post(`${SITE_URL}/api/status-refresh`, { slug }),
      post("https://api.indexnow.org/indexnow", {
        host: "exit1.dev",
        key: INDEXNOW_KEY,
        keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
        urlList: [pageUrl],
      }),
    ]);
    logger.info("[public-freshness] pushed", {
      slug,
      status,
      refresh: refresh.status === "fulfilled" ? refresh.value : String(refresh.reason),
      indexNow: indexNow.status === "fulfilled" ? indexNow.value : String(indexNow.reason),
    });
  } catch (error) {
    logger.warn("[public-freshness] push failed", { checkId: website.id, error: (error as Error)?.message });
  }
}
