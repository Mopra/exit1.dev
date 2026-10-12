import { useCallback, useEffect, useRef, useState } from 'react';
import type { Website } from '../../types';

type RowMotion = 'enter' | 'land' | 'reveal' | 'leave';

// Long enough for the CSS in motion.css to finish (row-enter is the longest).
const ENTER_MS = 1600;
const LAND_MS = 1200;
const REVEAL_MS = 800;
// How long a deleted row fades before it is actually removed.
const LEAVE_MS = 220;
// The list can still be filling in (Firestore, then the live stream) right
// after the page opens. Checks that show up in this window are not "new".
const SETTLE_MS = 3000;

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One-off motion for check rows: which rows just arrived, just landed after a
 * drag, are being revealed by a folder opening, or are on their way out.
 *
 * Arrivals are detected by diffing ids between renders, so a check added from
 * any path (form, bulk import, duplicate, another tab) slides in. Whatever
 * loads in the first few seconds is the baseline, and a wholesale swap
 * (switching account) is not treated as a hundred new checks.
 */
export function useRowMotion(checks: Website[]) {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [landed, setLanded] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(new Map());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    const ids = new Set(checks.map((c) => c.id));
    const prev = seen.current;
    seen.current = ids;
    if (!prev || reducedMotion() || Date.now() - mountedAt.current < SETTLE_MS) return;
    const added = [...ids].filter((id) => !prev.has(id));
    if (added.length === 0) return;
    const kept = [...prev].some((id) => ids.has(id));
    if (!kept && prev.size > 0) return;
    setFresh(new Set(added));
    // Not cleared on the next run: `checks` changes on every live tick, and
    // cancelling here would leave these rows marked new forever.
    setTimeout(() => setFresh((cur) => {
      const next = new Set(cur);
      added.forEach((id) => next.delete(id));
      return next;
    }), ENTER_MS);
  }, [checks]);

  const land = useCallback((id: string) => {
    if (reducedMotion()) return;
    setLanded(id);
    setTimeout(() => setLanded((cur) => (cur === id ? null : cur)), LAND_MS);
  }, []);

  const reveal = useCallback((ids: string[]) => {
    if (reducedMotion()) return;
    setRevealed(new Map(ids.map((id, i) => [id, i])));
    setTimeout(() => setRevealed(new Map()), REVEAL_MS);
  }, []);

  const leaveThen = useCallback((ids: string[], done: () => void) => {
    if (reducedMotion() || ids.length === 0) {
      done();
      return;
    }
    setLeaving((cur) => new Set([...cur, ...ids]));
    setTimeout(() => {
      done();
      setLeaving((cur) => {
        const next = new Set(cur);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, LEAVE_MS);
  }, []);

  const motionFor = (id: string): RowMotion | undefined => {
    if (leaving.has(id)) return 'leave';
    if (fresh.has(id)) return 'enter';
    if (landed === id) return 'land';
    if (revealed.has(id)) return 'reveal';
    return undefined;
  };

  return {
    motionFor,
    revealIndexFor: (id: string) => revealed.get(id) ?? 0,
    land,
    reveal,
    leaveThen,
  };
}
