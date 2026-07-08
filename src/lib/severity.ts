// P1–P5 importance scale shared by the check form, bulk edit, and list badges.
// Integrations map this to notification priority (Pushover pages P1 at
// Emergency, P4–P5 stay quiet). P3 keeps the integration's own default.

export type Severity = 1 | 2 | 3 | 4 | 5;

export const SEVERITY_LABELS: Record<Severity, string> = {
  1: 'P1 — Critical',
  2: 'P2 — High',
  3: 'P3 — Normal',
  4: 'P4 — Low',
  5: 'P5 — Minimal',
};

export const isSeverity = (value: unknown): value is Severity =>
  value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
