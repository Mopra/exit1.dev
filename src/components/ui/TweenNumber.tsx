import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 500;

/**
 * A number that counts to its new value instead of jumping, so a live
 * update reads as movement (195ms easing down to 30ms) rather than a flicker.
 * The first render shows the value as is; only later changes tween.
 * Instant under prefers-reduced-motion.
 */
export function TweenNumber({
  value,
  format,
}: {
  value: number | undefined;
  format: (value: number | undefined) => string;
}) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (value === undefined || from === undefined || from === value
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      // Whole numbers stay whole mid-tween; fractional ones (ping times like
      // 0.4ms) keep two decimals, so neither shows a long tail of digits.
      const next = from + (value - from) * eased;
      const whole = Number.isInteger(value) && Number.isInteger(from);
      shownRef.current = t === 1 ? value : whole ? Math.round(next) : Math.round(next * 100) / 100;
      setShown(shownRef.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{format(shown)}</>;
}
