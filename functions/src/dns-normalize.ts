import { DnsRecordType, DnsRecordBaseline, DnsRecordResult, DnsChange } from './types';

/**
 * Normalizes DNS record values for consistent comparison.
 * Each record type has specific normalization rules to handle
 * ordering, case, and trailing dot differences.
 */
export function normalizeDnsValues(recordType: DnsRecordType, values: unknown[]): string[] {
  switch (recordType) {
    case 'A':
    case 'AAAA':
      // IPs as strings, sorted lexicographically
      return (values as string[]).map(v => v.trim()).sort();

    case 'CNAME':
      // Lowercase, strip trailing dot, single value
      return (values as string[]).map(v => v.trim().toLowerCase().replace(/\.$/, '')).sort();

    case 'MX':
      // dns.resolveMx() returns { priority: number, exchange: string }[]
      return (values as { priority: number; exchange: string }[])
        .map(mx => `${mx.priority} ${mx.exchange.trim().toLowerCase().replace(/\.$/, '')}`)
        .sort();

    case 'TXT':
      // dns.resolveTxt() returns string[][] (chunked TXT records); join chunks, sort array
      return (values as string[][])
        .map(chunks => chunks.join(''))
        .sort();

    case 'NS':
      // Lowercase, strip trailing dot, sort
      return (values as string[]).map(v => v.trim().toLowerCase().replace(/\.$/, '')).sort();

    case 'SOA':
      // dns.resolveSoa() returns a single object
      const soa = values[0] as {
        nsname: string; hostmaster: string; serial: number;
        refresh: number; retry: number; expire: number; minttl: number;
      };
      return [`${soa.nsname.toLowerCase().replace(/\.$/, '')} ${soa.hostmaster.toLowerCase().replace(/\.$/, '')} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`];

    default:
      return (values as string[]).map(String).sort();
  }
}

/**
 * Compares current DNS results against baseline and returns detected changes.
 * Handles three cases: new records appearing, existing records disappearing,
 * and record values changing.
 */
export function compareDnsResults(
  baseline: Record<string, DnsRecordBaseline>,
  current: Record<string, DnsRecordResult>,
  recordTypes: DnsRecordType[],
  now: number,
): DnsChange[] {
  const changes: DnsChange[] = [];

  for (const rt of recordTypes) {
    const base = baseline[rt];
    const curr = current[rt];

    if (!base && curr && curr.values.length > 0) {
      // New record appeared — only flag if baseline was established (has an entry, even empty)
      if (baseline[rt] !== undefined) {
        changes.push({
          recordType: rt,
          changeType: 'added',
          previousValues: [],
          newValues: curr.values,
          detectedAt: now,
        });
      }
      continue;
    }

    if (base && (!curr || curr.values.length === 0)) {
      // Record was in baseline but now missing
      if (base.values.length > 0) {
        changes.push({
          recordType: rt,
          changeType: 'missing',
          previousValues: base.values,
          newValues: [],
          detectedAt: now,
        });
      }
      continue;
    }

    if (base && curr) {
      // Both exist — compare sorted arrays via JSON stringify
      const baseStr = JSON.stringify(base.values);
      const currStr = JSON.stringify(curr.values);
      if (baseStr !== currStr) {
        changes.push({
          recordType: rt,
          changeType: 'changed',
          previousValues: base.values,
          newValues: curr.values,
          detectedAt: now,
        });
      }
    }
  }

  return changes;
}
