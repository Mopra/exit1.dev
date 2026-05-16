/**
 * WebSocket endpoint resolution per check region.
 *
 * Each `checkRegion` value maps to a specific live-stream hostname. The
 * plan ([Docs/vps-live-primary.md]) calls out explicit per-region subdomains
 * over a single geo-routed hostname so the frontend can address each
 * region deterministically (a US-based user with EU checks still needs to
 * hit live-eu).
 *
 * Defaults are the production hostnames. Override via env for staging
 * (e.g. point at a single VPS in dev rather than running two).
 */

import type { Website } from '../types';

type CheckRegion = NonNullable<Website['checkRegion']>;

/**
 * Returns the wss:// URL for a region, or null if no WS endpoint is
 * configured for that region — typically because the region is one of the
 * legacy non-VPS values (us-central1, europe-west1, asia-southeast1) which
 * have no live checks in production but linger in the type union.
 */
export function getWsEndpoint(region: CheckRegion): string | null {
  switch (region) {
    case 'vps-eu-1':
      return import.meta.env.VITE_WS_LIVE_EU ?? 'wss://live-eu.exit1.dev/ws';
    case 'vps-us-1':
      return import.meta.env.VITE_WS_LIVE_US ?? 'wss://live-us.exit1.dev/ws';
    // Pre-VPS regions: no WS endpoint. Production has zero checks here per
    // the pre-flight survey (see vps-live-primary.md). Returning null lets
    // useCheckStream skip them silently rather than throwing.
    case 'us-central1':
    case 'europe-west1':
    case 'asia-southeast1':
      return null;
    default: {
      // Exhaustiveness check — if a future region is added to the union,
      // TypeScript flags this branch and we update the switch.
      const _exhaustive: never = region;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Returns the unique set of regions present in a checks list that have a
 * configured WS endpoint. Used by useCheckStream to decide which sockets
 * to open.
 */
export function regionsForChecks(checks: Website[]): CheckRegion[] {
  const seen = new Set<CheckRegion>();
  for (const c of checks) {
    if (c.checkRegion && getWsEndpoint(c.checkRegion) !== null) {
      seen.add(c.checkRegion);
    }
  }
  return Array.from(seen);
}
