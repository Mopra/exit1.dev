/**
 * Daily watch on the runner's kernel egress rules (vps/ops, nftables table
 * `inet exit1_runner`). Mails when the backstop behind the SSRF guard is gone
 * or was hit:
 *
 *  - the rules are not loaded,
 *  - the runner does not run as `exit1run`, so the rules do not apply to it,
 *  - the status file is missing or old (the root timer that writes it is dead),
 *  - the refuse counter rose, which means a probe or webhook got past the
 *    app-level guard in functions/src/ssrf-guard.ts.
 *
 * Reading nftables needs root and the runner has none. A root timer on the box
 * (vps/ops/egress-status.sh) writes /run/exit1-egress/status every 10 minutes
 * and this job only reads that file. It runs on each box by itself (a perHost
 * cron job), since each box has its own rules.
 *
 * Silent when all is well. No Firestore or BigQuery of its own: the only cost
 * is the cron claim (see cron.ts).
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';

export const RUN_USER = 'exit1run';
/** The timer writes every 10 minutes; three misses in a row is not a blip. */
export const STALE_MS = 45 * 60_000;
const STATUS_FILE = process.env.EGRESS_STATUS_FILE || '/run/exit1-egress/status';
const STATE_FILE = process.env.EGRESS_WATCH_STATE || '/var/lib/exit1/egress-watch-state.json';
const MAIL_TO = 'morten@exit1.dev';
const MAX_LOG_LINES = 10;

export type EgressStatus = {
  /** When the root timer looked, ms. */
  checkedAt: number;
  loaded: boolean;
  /** The kernel counter now; starts over on a reload. null when not readable. */
  refused: number | null;
  /** Refused packets ever seen by the root timer; survives reloads and boots. */
  total: number;
  /** How many of `total` were made on purpose by `runner-user.sh test`. */
  testTotal: number;
  /** Kernel log lines of refused packets, last 25 hours, oldest first. */
  log: string[];
};

export type WatchState = {
  total: number;
  testTotal: number;
  /** When the root timer wrote the status this state was taken from, ms. */
  at: number;
};

export type Verdict = {
  problems: string[];
  /** Refused packets since the last run that no test accounts for. */
  rise: number;
  /** State to keep for the next run; null means keep the old one. */
  next: WatchState | null;
  /** Log lines to show with a rise. */
  recent: string[];
};

/** Parses the key=value file written by vps/ops/egress-status.sh. */
export function parseStatus(text: string): EgressStatus | null {
  const fields = new Map<string, string>();
  const log: string[] = [];
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'log') log.push(value);
    else fields.set(key, value);
  }
  const checkedAt = Number(fields.get('checkedAt'));
  const loaded = fields.get('loaded');
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || (loaded !== '0' && loaded !== '1')) return null;
  const refusedRaw = fields.get('refused') ?? '';
  const totalRaw = fields.get('total') ?? '';
  const testRaw = fields.get('testTotal') ?? '';
  if (!/^\d+$/.test(totalRaw)) return null;
  return {
    checkedAt: checkedAt * 1000,
    loaded: loaded === '1',
    refused: /^\d+$/.test(refusedRaw) ? Number(refusedRaw) : null,
    total: Number(totalRaw),
    testTotal: /^\d+$/.test(testRaw) ? Number(testRaw) : 0,
    log,
  };
}

/** `<time> <proto> <dst>:<port> via <if>` from a kernel log line, else the line. */
export function shortLog(line: string): string {
  const time = line.split(' ', 1)[0];
  const field = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(line)?.[1];
  const dst = field('DST');
  if (!dst) return line;
  const port = field('DPT');
  const out = field('OUT');
  return `${time}  ${field('PROTO') ?? '?'}  ${port ? `${dst} port ${port}` : dst}${out ? `  via ${out}` : ''}`;
}

function logTime(line: string): number {
  const t = Date.parse(line.split(' ', 1)[0]);
  return Number.isFinite(t) ? t : 0;
}

/** Pure decision, separated out for tests. */
export function judge(input: {
  status: EgressStatus | null;
  prev: WatchState | null;
  now: number;
  runUser: string;
}): Verdict {
  const { status, prev, now, runUser } = input;
  const problems: string[] = [];
  const stop = (): Verdict => ({ problems, rise: 0, next: null, recent: [] });

  if (runUser !== RUN_USER) {
    problems.push(
      `The runner runs as "${runUser}", not "${RUN_USER}". The egress rules only match ${RUN_USER}, so they do not protect it.`,
    );
  }
  if (!status) {
    problems.push(
      `No readable status at ${STATUS_FILE}. The timer exit1-egress-status.timer is not installed or not running, so nobody is looking at the rules. Fix: cd /opt/exit1/repo/vps/ops && ./runner-user.sh setup`,
    );
    return stop();
  }
  const ageMin = Math.round((now - status.checkedAt) / 60_000);
  if (now - status.checkedAt > STALE_MS) {
    problems.push(
      `The status is ${ageMin} minutes old (it is written every 10). Check: systemctl status exit1-egress-status.timer exit1-egress-status.service`,
    );
    return stop();
  }
  if (!status.loaded) {
    problems.push(
      'The egress rules are NOT loaded. The runner is on the app-level SSRF guard alone. Fix: sudo systemctl start exit1-runner-egress.service, or ./runner-user.sh setup',
    );
  }

  // `at` is when the count was taken, not when this job ran, so a packet
  // refused in between is not cut from tomorrow's log lines.
  const next: WatchState = { total: status.total, testTotal: status.testTotal, at: status.checkedAt };
  // First run on this box, or the root timer's own total was wiped: baseline.
  if (!prev || status.total < prev.total || status.testTotal < prev.testTotal) {
    return { problems, rise: 0, next, recent: [] };
  }

  const rise = Math.max(0, status.total - prev.total - (status.testTotal - prev.testTotal));
  let recent: string[] = [];
  if (rise > 0) {
    problems.push(
      `The kernel refused ${rise} packet${rise === 1 ? '' : 's'} from the runner since ${new Date(prev.at).toISOString()}. Something got past the app-level guard (functions/src/ssrf-guard.ts). Find the check or webhook behind the destination below and fix the guard.`,
    );
    recent = status.log.filter((l) => logTime(l) > prev.at).slice(-MAX_LOG_LINES).map(shortLog);
  }
  return { problems, rise, next, recent };
}

export function buildEmail(region: string, verdict: Verdict): { subject: string; text: string; html: string } {
  const lines = [`Runner egress rules on ${region}`, ''];
  verdict.problems.forEach((p, i) => lines.push(`${i + 1}. ${p}`, ''));
  if (verdict.rise > 0) {
    if (verdict.recent.length) {
      lines.push('Refused packets in the kernel log (at most 6 a minute are logged):');
      for (const l of verdict.recent) lines.push(`  ${l}`);
    } else {
      lines.push('No matching kernel log lines. Look with: sudo journalctl -k | grep exit1-runner-egress');
    }
    lines.push('');
  }
  lines.push(
    'On the box: cd /opt/exit1/repo/vps/ops && ./runner-user.sh status',
    'Sent by the egress watch (vps/src/egress-watch.ts, cron 08:45 UTC). Background: vps/ops/README.md.',
  );
  const text = lines.join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<pre style="font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap">${esc(text)}</pre>`;
  const what = verdict.rise > 0
    ? `${verdict.rise} refused packet${verdict.rise === 1 ? '' : 's'}`
    : 'rules not in place';
  return { subject: `exit1 egress watch ${region}: ${what}`, text, html };
}

async function readStatus(): Promise<EgressStatus | null> {
  try {
    return parseStatus(await readFile(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function readState(): Promise<WatchState | null> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Partial<WatchState>;
    if (typeof s.total !== 'number' || typeof s.at !== 'number') return null;
    return { total: s.total, testTotal: Number(s.testTotal) || 0, at: s.at };
  } catch {
    return null;
  }
}

async function writeState(state: WatchState): Promise<void> {
  await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state));
  await rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

export async function runEgressWatch(region: string, now: number = Date.now()): Promise<void> {
  const verdict = judge({
    status: await readStatus(),
    prev: await readState(),
    now,
    runUser: userInfo().username,
  });
  console.info(`[egress-watch] ${region}: ${verdict.problems.length} problem(s), rise ${verdict.rise}`);

  if (verdict.problems.length) {
    // @ts-expect-error: functions/lib has no .d.ts
    const mail = await import('../../functions/lib/email-send.js');
    if (!mail.isTransactionalEmailConfigured()) {
      throw new Error(`no email provider configured; problems: ${verdict.problems.join(' | ')}`);
    }
    await mail.sendTransactionalEmail({ to: MAIL_TO, ...buildEmail(region, verdict), category: 'internal' });
  }
  // Only after the mail is out: a send that failed reports the same rise again
  // tomorrow instead of losing it.
  if (verdict.next) await writeState(verdict.next);
}
