import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import type { SlaPeriod, SlaReport } from '@/types';

const REPORTS = 'sla_reports';
const PERIODS = 'periods';

/**
 * Live list of the account's SLA reports. Reads only: every write goes
 * through the callables. Uses the (userId, createdAt desc) index.
 */
export function useSlaReports(accountId: string | null) {
  const [reports, setReports] = useState<SlaReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setReports([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(collection(db, REPORTS), where('userId', '==', accountId), orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        setReports(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SlaReport, 'id'>) })));
        setError(null);
        setLoading(false);
      },
      (err) => {
        console.error('[SLA] Failed to load reports:', err);
        setError('Could not load SLA reports.');
        setLoading(false);
      },
    );
  }, [accountId]);

  return { reports, loading, error };
}

/** Live single report. `undefined` while loading, `null` when it doesn't exist. */
export function useSlaReport(reportId: string | undefined) {
  const [report, setReport] = useState<SlaReport | null | undefined>(undefined);

  useEffect(() => {
    if (!reportId) {
      setReport(null);
      return;
    }
    setReport(undefined);
    return onSnapshot(
      doc(db, REPORTS, reportId),
      (snap) => setReport(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<SlaReport, 'id'>) }) : null),
      (err) => {
        console.error('[SLA] Failed to load report:', err);
        setReport(null);
      },
    );
  }, [reportId]);

  return report;
}

/**
 * Live period doc (`sla_reports/{id}/periods/{YYYY-MM}`). `undefined` while
 * loading, `null` when the month has not been computed yet.
 *
 * The rules read `resource.data.userId`, so a missing doc answers with
 * permission-denied and Firestore ends the listener. Bump `nonce` after a
 * refresh to listen again.
 */
export function useSlaPeriod(reportId: string | undefined, period: string | null, nonce = 0) {
  const [state, setState] = useState<{ key: string; value: SlaPeriod | null } | null>(null);
  const key = reportId && period ? `${reportId}/${period}#${nonce}` : '';

  useEffect(() => {
    if (!reportId || !period) return;
    const k = `${reportId}/${period}#${nonce}`;
    return onSnapshot(
      doc(db, REPORTS, reportId, PERIODS, period),
      (snap) => setState({ key: k, value: snap.exists() ? (snap.data() as SlaPeriod) : null }),
      (err) => {
        console.error('[SLA] Failed to load period:', err);
        setState({ key: k, value: null });
      },
    );
  }, [reportId, period, nonce]);

  if (!key) return null;
  // Ignore a stale value from the previous report or month while the new one loads.
  return state && state.key === key ? state.value : undefined;
}
