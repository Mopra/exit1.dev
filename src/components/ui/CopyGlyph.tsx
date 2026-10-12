import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The icon on a copy button: a copy glyph that turns into a tick for a
 * moment after a successful copy (it pops in and draws itself, see
 * `.copy-done` in motion.css), so the button itself confirms the copy.
 */
export function CopyGlyph({ copied, className }: { copied: boolean; className?: string }) {
  if (!copied) return <Copy className={className} />;
  // The wrapper carries the pop. On the svg itself, icon-motion.css's hover
  // rule (the cursor is on the button when you click it) would override it.
  return (
    <span className="copy-done inline-flex">
      <Check className={cn(className, 'text-primary')} />
    </span>
  );
}

/**
 * Which copy button (by key) just copied. `markCopied(key)` shows its tick
 * for `ms`, then it reverts. One per component covers several buttons.
 */
export function useCopiedKey(ms = 1500): [string | null, (key: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const markCopied = useCallback((key: string) => {
    clearTimeout(timer.current);
    setCopied(key);
    timer.current = setTimeout(() => setCopied(null), ms);
  }, [ms]);
  return [copied, markCopied];
}
