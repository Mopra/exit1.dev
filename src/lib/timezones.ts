// IANA time zone helpers shared by the maintenance dialog and SLA reports.

/** The browser's own IANA zone, e.g. "Europe/Copenhagen". */
export function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone the browser knows, or just the detected one on old engines. */
export function allTimeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [detectedTimeZone()];
  }
}
