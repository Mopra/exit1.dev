import { useSyncExternalStore, useCallback } from "react";

export type TierPreview = "agency" | "pro" | "nano" | "free";

const STORAGE_KEY = "adminTierPreview";
const FOUNDERS_KEY = "adminTierPreviewFounders";

// Cycle sequence: highest → lowest. Founders is a distinct stop between
// agency and pro (Founders resolves to pro-tier entitlements but renders a
// special badge variant).
const TIERS: TierPreview[] = ["agency", "pro", "nano", "free"];

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((l) => l());
}

function readTier(): TierPreview {
  const raw = localStorage.getItem(STORAGE_KEY);
  // Migrate legacy "scale" → "agency" in-place so consumers never see it.
  if (raw === "scale") {
    localStorage.setItem(STORAGE_KEY, "agency");
    return "agency";
  }
  if (raw === "agency" || raw === "pro" || raw === "nano" || raw === "free") {
    return raw;
  }
  return "agency";
}

function readFounders(): boolean {
  return localStorage.getItem(FOUNDERS_KEY) === "true";
}

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value between unchanged reads. Cache the composite snapshot object.
let cachedSnapshot: { previewTier: TierPreview; previewIsFounders: boolean } = {
  previewTier: "agency",
  previewIsFounders: false,
};
let snapshotInitialized = false;

function refreshSnapshot(): void {
  const rawTier = readTier();
  const founders = readFounders();
  // When Founders preview is on, emit 'pro' (Founders' resolved tier). The UI
  // reads `previewIsFounders` separately to render the Founders badge variant.
  const tier: TierPreview = founders ? "pro" : rawTier;
  if (
    !snapshotInitialized ||
    cachedSnapshot.previewTier !== tier ||
    cachedSnapshot.previewIsFounders !== founders
  ) {
    cachedSnapshot = { previewTier: tier, previewIsFounders: founders };
    snapshotInitialized = true;
  }
}

function getSnapshot() {
  refreshSnapshot();
  return cachedSnapshot;
}

const SERVER_SNAPSHOT = {
  previewTier: "agency" as TierPreview,
  previewIsFounders: false,
};

function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

function writeTier(next: TierPreview): void {
  localStorage.setItem(STORAGE_KEY, next);
  refreshSnapshot();
  notify();
}

function writeFounders(next: boolean): void {
  if (next) localStorage.setItem(FOUNDERS_KEY, "true");
  else localStorage.removeItem(FOUNDERS_KEY);
  refreshSnapshot();
  notify();
}

export function useAdminTierPreview(): {
  previewTier: TierPreview;
  previewIsFounders: boolean;
  cycleTier: () => void;
  setTier: (t: TierPreview) => void;
  toggleFounders: () => void;
} {
  const { previewTier, previewIsFounders } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  // Cycle sequence with Founders as a distinct stop:
  //   agency → pro-founders → pro → nano → free → agency ...
  const cycleTier = useCallback(() => {
    const currentTier = readTier();
    const currentFounders = readFounders();

    if (currentTier === "agency") {
      // agency → pro (founders on)
      writeTier("pro");
      writeFounders(true);
      return;
    }
    if (currentTier === "pro" && currentFounders) {
      // pro-founders → pro (founders off)
      writeFounders(false);
      return;
    }
    // pro → nano, nano → free, free → agency (and founders always off at these stops)
    const idx = TIERS.indexOf(currentTier);
    const next = TIERS[(idx + 1) % TIERS.length];
    if (currentFounders) writeFounders(false);
    writeTier(next);
  }, []);

  const setTier = useCallback((t: TierPreview) => {
    writeTier(t);
  }, []);

  const toggleFounders = useCallback(() => {
    writeFounders(!readFounders());
  }, []);

  return {
    previewTier,
    previewIsFounders,
    cycleTier,
    setTier,
    toggleFounders,
  };
}
