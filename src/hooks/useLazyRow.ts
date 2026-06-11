/**
 * Viewport-gated row rendering for large tables.
 *
 * With 100+ checks the table mounts 100+ heavy rows (each ~7 Radix
 * tooltips, a dropdown, a 1Hz countdown). This hook lets a row keep its
 * `<tr>` mounted (so dnd-kit registration, selection and table layout are
 * untouched) while swapping its cells for a single fixed-height
 * placeholder whenever the row is far from the viewport. Offscreen rows
 * therefore stop subscribing to the shared second tick and stop animating
 * their countdown bars.
 *
 * One module-level IntersectionObserver drives every row — adding rows
 * adds Map entries, not observers. The 600px rootMargin mounts content
 * well before it scrolls into view, so users never see placeholders at
 * normal scroll speeds.
 *
 * When a row leaves the margin we record its last rendered height from
 * the observer entry and size the placeholder with it, so hiding content
 * doesn't shift the scroll position.
 */
import { useCallback, useRef, useState } from 'react';

type EntryCallback = (entry: IntersectionObserverEntry) => void;

const rowCallbacks = new Map<Element, EntryCallback>();
let sharedObserver: IntersectionObserver | null = null;

function getSharedObserver(): IntersectionObserver {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) rowCallbacks.get(entry.target)?.(entry);
      },
      { rootMargin: '600px 0px 600px 0px' }
    );
  }
  return sharedObserver;
}

export interface LazyRowState {
  /** Callback ref — attach to the row element (`<tr>`). */
  rowRef: (el: Element | null) => void;
  /** True when the row is within 600px of the viewport. */
  isNear: boolean;
  /** Height (px) for the placeholder cell while content is unmounted. */
  placeholderHeight: number;
}

export function useLazyRow(initiallyVisible: boolean, estimatedHeight = 89): LazyRowState {
  // No IntersectionObserver (very old browsers / jsdom) → always render.
  const supported = typeof IntersectionObserver !== 'undefined';
  const [isNear, setIsNear] = useState(initiallyVisible || !supported);
  const heightRef = useRef(estimatedHeight);
  const elRef = useRef<Element | null>(null);

  const rowRef = useCallback((el: Element | null) => {
    if (!supported) return;
    if (elRef.current && elRef.current !== el) {
      getSharedObserver().unobserve(elRef.current);
      rowCallbacks.delete(elRef.current);
    }
    elRef.current = el;
    if (el) {
      rowCallbacks.set(el, (entry) => {
        if (!entry.isIntersecting) {
          // Capture the height the row had at the moment it left the
          // margin — that's the full-content height, used to size the
          // placeholder so the page doesn't jump.
          const h = entry.boundingClientRect.height;
          if (h > 0) heightRef.current = h;
        }
        setIsNear(entry.isIntersecting);
      });
      getSharedObserver().observe(el);
    }
  }, [supported]);

  return { rowRef, isNear, placeholderHeight: heightRef.current };
}
