# Cost Optimization (1-Minute Checks)

This document summarizes the changes to reduce Cloud Run cost while keeping the 1-minute check interval.

## Goals
- Keep 1-minute checks for all monitors.
- Reduce CPU-seconds and BigQuery write volume.
- Avoid false downs with shorter timeouts.
- Keep nano-only multi-region behavior.

## Changes Applied
- History writes now happen only on state change (online <-> offline). BigQuery stats/intervals are computed from state-change events.
- Immediate re-check is disabled by default for new checks. It can still be enabled per check.
- HTTP timeouts are shorter to reduce CPU-seconds. Transient errors (timeouts/5xx) still require consecutive failures before marking offline.
- SSL, DNS, and GEO metadata refresh at most once per week. The security refresh job runs weekly.
- Nano checks still use multi-region; new checks start in us-central1 and auto-migrate after the first check resolves geo.

## One-Time Migration (Existing Checks)
To disable immediate re-check on all existing checks, run the admin callable function:
- Function: `disableImmediateRecheckForAllChecks`
- Behavior: sets `immediateRecheckEnabled = false` on all checks where it is currently true.

## Operational Notes
- Uptime is now computed from state-change intervals, not raw check counts.
- Response time charts are based on sampled events (fewer samples, lower BigQuery cost).
- If false downs appear, adjust `HTTP_TIMEOUT_MS` or `TRANSIENT_ERROR_THRESHOLD` in `functions/src/config.ts`.

