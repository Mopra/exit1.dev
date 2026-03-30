import { useSyncExternalStore, useCallback } from "react";

export type TierPreview = "scale" | "nano" | "free";

const STORAGE_KEY = "adminTierPreview";
const TIERS: TierPreview[] = ["scale", "nano", "free"];

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): TierPreview {
  return (localStorage.getItem(STORAGE_KEY) as TierPreview) ?? "scale";
}

function getServerSnapshot(): TierPreview {
  return "scale";
}

export function useAdminTierPreview() {
  const previewTier = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const cycleTier = useCallback(() => {
    const current = getSnapshot();
    const next = TIERS[(TIERS.indexOf(current) + 1) % TIERS.length];
    localStorage.setItem(STORAGE_KEY, next);
    listeners.forEach((l) => l());
  }, []);

  return { previewTier, cycleTier };
}
