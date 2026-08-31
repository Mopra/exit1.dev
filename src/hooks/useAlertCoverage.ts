import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { willDeliver, type GateSettings } from '../lib/notification-shared';
import type { Website } from '../types';

/**
 * Can this user actually be told when a check goes down?
 *
 * An audit of production found 380 of 588 users holding a live check with no
 * reachable channel at all: no email settings document, no enabled webhook, no
 * SMS. They were monitoring things that could never notify them, and nothing in
 * the app said so. This hook is what lets the UI say so.
 *
 * Coverage is judged with `willDeliver`, the same precedence the alert path runs,
 * rather than "is there an address on file". That distinction is the whole point:
 * 386 of 404 existing settings documents have a recipient saved and still deliver
 * nothing, because the check filter defaults to 'Selected only'.
 */
export interface AlertCoverage {
  /** False until every source has reported, so the banner cannot flash. */
  ready: boolean;
  /** Checks the scheduler will actually run. */
  enabledCheckCount: number;
  /** Enabled checks that would produce a down email. */
  emailCoveredCount: number;
  hasWebhook: boolean;
  hasSmsChannel: boolean;
  /** True when at least one enabled check can reach the user somehow. */
  covered: boolean;
  /**
   * The case worth interrupting someone over: they own live monitors and not one
   * of them can reach anybody.
   */
  hasBlindSpot: boolean;
}

const EVENT = 'website_down' as const;

export function useAlertCoverage(
  userId: string | null | undefined,
  checks: Website[],
  /** Pass `smsAlerts` from usePlan(): a configured doc on a tier without SMS sends nothing. */
  smsAllowedByTier: boolean,
): AlertCoverage {
  const [emailSettings, setEmailSettings] = useState<GateSettings | null>(null);
  const [smsSettings, setSmsSettings] = useState<GateSettings | null>(null);
  const [webhookCount, setWebhookCount] = useState<number | null>(null);
  const [emailReady, setEmailReady] = useState(false);
  const [smsReady, setSmsReady] = useState(false);

  useEffect(() => {
    if (!userId) {
      setEmailReady(false);
      setSmsReady(false);
      setWebhookCount(null);
      return;
    }

    // Fail CLOSED on a read error, in both directions: an unreadable settings
    // document is reported as "no coverage" (so the warning shows) but `ready`
    // still flips, so a permissions blip cannot leave the banner hidden forever.
    const unsubEmail = onSnapshot(
      doc(db, 'emailSettings', userId),
      (snap) => {
        setEmailSettings(snap.exists() ? (snap.data() as GateSettings) : null);
        setEmailReady(true);
      },
      () => {
        setEmailSettings(null);
        setEmailReady(true);
      },
    );

    const unsubSms = onSnapshot(
      doc(db, 'smsSettings', userId),
      (snap) => {
        setSmsSettings(snap.exists() ? (snap.data() as GateSettings) : null);
        setSmsReady(true);
      },
      () => {
        setSmsSettings(null);
        setSmsReady(true);
      },
    );

    const unsubHooks = onSnapshot(
      query(
        collection(db, 'webhooks'),
        where('userId', '==', userId),
        where('enabled', '==', true),
      ),
      (snap) => setWebhookCount(snap.size),
      () => setWebhookCount(0),
    );

    return () => {
      unsubEmail();
      unsubSms();
      unsubHooks();
    };
  }, [userId]);

  return useMemo<AlertCoverage>(() => {
    const enabled = checks.filter((c) => !c.disabled);
    const emailCoveredCount = enabled.filter((c) =>
      willDeliver(emailSettings, { id: c.id, folder: c.folder }, EVENT)).length;
    const hasSmsChannel = smsAllowedByTier
      && enabled.some((c) => willDeliver(smsSettings, { id: c.id, folder: c.folder }, EVENT));
    const hasWebhook = (webhookCount ?? 0) > 0;
    const covered = emailCoveredCount > 0 || hasWebhook || hasSmsChannel;
    const ready = Boolean(userId) && emailReady && smsReady && webhookCount !== null;

    return {
      ready,
      enabledCheckCount: enabled.length,
      emailCoveredCount,
      hasWebhook,
      hasSmsChannel,
      covered,
      hasBlindSpot: ready && enabled.length > 0 && !covered,
    };
  }, [checks, emailSettings, smsSettings, webhookCount, smsAllowedByTier, userId, emailReady, smsReady]);
}
