/**
 * The daily egress watch mails when the kernel rules are gone or were hit, and
 * stays quiet for reloads and for the packets `runner-user.sh test` makes.
 *
 * Run: npm test (in vps/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_USER,
  STALE_MS,
  buildEmail,
  judge,
  parseStatus,
  shortLog,
  type EgressStatus,
  type WatchState,
} from '../egress-watch.js';

const NOW = Date.parse('2026-11-15T08:45:00Z');
const DAY = 24 * 60 * 60_000;
const LINE =
  '2026-11-15T03:30:01+00:00 srv1387547 kernel: exit1-runner-egress: IN= OUT=lo SRC=10.0.0.1 DST=10.0.0.1 LEN=60 TOS=0x00 PROTO=TCP SPT=33730 DPT=3100 WINDOW=65495';

function status(over: Partial<EgressStatus> = {}): EgressStatus {
  return { checkedAt: NOW - 60_000, loaded: true, refused: 0, total: 0, testTotal: 0, log: [], ...over };
}
function prev(over: Partial<WatchState> = {}): WatchState {
  return { total: 0, testTotal: 0, at: NOW - DAY, ...over };
}
const run = (s: EgressStatus | null, p: WatchState | null, runUser = RUN_USER) =>
  judge({ status: s, prev: p, now: NOW, runUser });

test('parseStatus reads the file the root timer writes', () => {
  const s = parseStatus(
    ['checkedAt=1794732300', 'loaded=1', 'refused=3', 'total=37', 'testTotal=34', `log=${LINE}`, ''].join('\n'),
  );
  assert.deepEqual(s, {
    checkedAt: 1794732300_000, loaded: true, refused: 3, total: 37, testTotal: 34, log: [LINE],
  });
});

test('parseStatus: rules gone gives loaded false and no count', () => {
  const s = parseStatus('checkedAt=1794732300\nloaded=0\nrefused=\ntotal=17\ntestTotal=0\n');
  assert.equal(s?.loaded, false);
  assert.equal(s?.refused, null);
  assert.equal(s?.total, 17);
});

test('parseStatus: junk or a half written file is no status', () => {
  assert.equal(parseStatus(''), null);
  assert.equal(parseStatus('hello'), null);
  assert.equal(parseStatus('loaded=1\ntotal=3\n'), null);
  assert.equal(parseStatus('checkedAt=1794732300\nloaded=maybe\ntotal=3\n'), null);
  assert.equal(parseStatus('checkedAt=1794732300\nloaded=1\nrefused=3\n'), null);
});

test('all well: no problems, state moves on', () => {
  const v = run(status({ total: 4 }), prev({ total: 4 }));
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.next, { total: 4, testTotal: 0, at: NOW - 60_000 });
});

test('no status file: one problem, old state kept', () => {
  const v = run(null, prev());
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /runner-user\.sh setup/);
  assert.equal(v.next, null);
});

test('stale status: reported, and its old count is not trusted', () => {
  const v = run(status({ checkedAt: NOW - STALE_MS - 1, total: 99 }), prev());
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /minutes old/);
  assert.equal(v.rise, 0);
  assert.equal(v.next, null);
  assert.deepEqual(run(status({ checkedAt: NOW - STALE_MS + 1000 }), prev()).problems, []);
});

test('rules not loaded: reported every run while it lasts', () => {
  const down = status({ loaded: false, refused: null, total: 5 });
  const first = run(down, prev({ total: 5 }));
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0], /NOT loaded/);
  assert.ok(first.next);
  assert.equal(run(down, first.next).problems.length, 1);
});

test('rules not loaded after a rise: both are reported', () => {
  const v = run(status({ loaded: false, refused: null, total: 7 }), prev({ total: 5 }));
  assert.equal(v.problems.length, 2);
  assert.equal(v.rise, 2);
});

test('runner under another user: reported even with the rules loaded', () => {
  const v = run(status(), prev(), 'agent');
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /runs as "agent"/);
  assert.ok(v.next);
});

test('counter rose: reported with the log lines since the last run', () => {
  const old = LINE.replace('2026-11-15T03:30:01', '2026-11-14T03:30:01');
  const v = run(status({ total: 5, log: [old, LINE] }), prev({ total: 2 }));
  assert.equal(v.rise, 3);
  assert.match(v.problems[0], /refused 3 packets/);
  assert.deepEqual(v.recent, ['2026-11-15T03:30:01+00:00  TCP  10.0.0.1 port 3100  via lo']);
  assert.equal(v.next?.total, 5);
});

test('a packet refused between the status write and the run keeps its log line', () => {
  // Day 1: status written 08:36, the job runs 08:45, a packet is refused 08:40.
  const wrote = Date.parse('2026-11-14T08:36:00Z');
  const day1 = judge({
    status: status({ checkedAt: wrote }), prev: prev({ at: wrote - DAY }), now: wrote + 9 * 60_000, runUser: RUN_USER,
  });
  const late = LINE.replace('2026-11-15T03:30:01', '2026-11-14T08:40:00');
  const day2 = run(status({ total: 1, log: [late] }), day1.next);
  assert.equal(day2.rise, 1);
  assert.equal(day2.recent.length, 1);
});

test('first run on a box: baseline only', () => {
  const v = run(status({ total: 17 }), null);
  assert.deepEqual(v.problems, []);
  assert.equal(v.next?.total, 17);
});

test('a reload zeroes the kernel counter but not the total', () => {
  assert.equal(run(status({ refused: 0, total: 17 }), prev({ total: 17 })).rise, 0);
  assert.equal(run(status({ refused: 0, total: 19 }), prev({ total: 17 })).rise, 2);
});

test('root total wiped: new baseline, no alert', () => {
  const v = run(status({ total: 3 }), prev({ total: 17 }));
  assert.deepEqual(v.problems, []);
  assert.equal(v.next?.total, 3);
});

test('a test run is credited and does not alert', () => {
  const v = run(status({ total: 34, testTotal: 34 }), prev({ total: 17, testTotal: 17 }));
  assert.equal(v.rise, 0);
  assert.deepEqual(v.problems, []);
  assert.equal(v.next?.testTotal, 34);
});

test('a test and 3 real ones: 3', () => {
  assert.equal(run(status({ total: 60, testTotal: 34 }), prev({ total: 40, testTotal: 17 })).rise, 3);
});

test('more credit than packets never goes below zero', () => {
  assert.equal(run(status({ total: 5, testTotal: 9 }), prev({ total: 5 })).rise, 0);
});

test('shortLog keeps a line it can not read, and handles ICMP', () => {
  assert.equal(shortLog('something else'), 'something else');
  assert.equal(
    shortLog('2026-11-15T03:30:01+00:00 box kernel: exit1-runner-egress: IN= OUT=lo SRC=127.0.0.1 DST=127.0.0.1 PROTO=ICMP TYPE=8'),
    '2026-11-15T03:30:01+00:00  ICMP  127.0.0.1  via lo',
  );
});

test('mail names the region and escapes the body', () => {
  const v = run(status({ total: 1, log: [LINE] }), prev());
  const mail = buildEmail('vps-eu-1', v);
  assert.equal(mail.subject, 'exit1 egress watch vps-eu-1: 1 refused packet');
  assert.match(mail.text, /10\.0\.0\.1 port 3100/);
  const down = buildEmail('vps-us-1', run(null, null, 'a<b'));
  assert.equal(down.subject, 'exit1 egress watch vps-us-1: rules not in place');
  assert.match(down.html, /a&lt;b/);
});
