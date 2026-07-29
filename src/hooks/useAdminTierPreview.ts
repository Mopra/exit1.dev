import { useSyncExternalStore, useCallback } from "react";

export type TierPreview = "pro" | "nano" | "indie" | "free";

const STORAGE_KEY = "adminTierPreview";
const FOUNDERS_KEY = "adminTierPreviewFounders";

// Cycle sequence: highest → lowest. Founders is a distinct stop right after
// pro (Founders resolves to pro-tier entitlements but renders a special badge
// variant).
const TIERS: TierPreview[] = ["pro", "nano", "indie", "free"];

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
  // Migrate retired "scale"/"agency" → "pro" in-place so consumers never see them.
  if (raw === "scale" || raw === "agency") {
    localStorage.setItem(STORAGE_KEY, "pro");
    return "pro";
  }
  if (raw === "pro" || raw === "nano" || raw === "indie" || raw === "free") {
    return raw;
  }
  return "pro";
}

function readFounders(): boolean {
  return localStorage.getItem(FOUNDERS_KEY) === "true";
}

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value between unchanged reads. Cache the composite snapshot object.
let cachedSnapshot: { previewTier: TierPreview; previewIsFounders: boolean } = {
  previewTier: "pro",
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
  previewTier: "pro" as TierPreview,
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
  //   pro → pro-founders → nano → indie → free → pro ...
  const cycleTier = useCallback(() => {
    const currentTier = readTier();
    const currentFounders = readFounders();

    if (currentTier === "pro" && !currentFounders) {
      // pro → pro (founders on)
      writeFounders(true);
      return;
    }
    // pro-founders → nano, nano → indie, indie → free, free → pro
    // (founders always off at these stops)
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
