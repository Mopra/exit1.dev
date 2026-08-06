import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkIds,
  capWebsiteIds,
  SUMMARY_QUERY_CHUNK,
  MAX_SUMMARY_WEBSITES,
} from '../summary-batching';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `check_${String(i).padStart(3, '0')}`);

test('chunking covers every id exactly once', () => {
  const input = ids(137);
  const chunks = chunkIds(input, 50);
  assert.deepEqual(chunks.flat(), input);
  assert.equal(new Set(chunks.flat()).size, input.length);
});

test('chunk sizes respect the limit, with only the tail short', () => {
  const chunks = chunkIds(ids(137), 50);
  assert.deepEqual(chunks.map((c) => c.length), [50, 50, 37]);
});

test('an exact multiple produces no empty trailing chunk', () => {
  const chunks = chunkIds(ids(100), 50);
  assert.deepEqual(chunks.map((c) => c.length), [50, 50]);
});

test('empty input yields no chunks', () => {
  assert.deepEqual(chunkIds([], 50), []);
});

test('a non-positive chunk size is rejected rather than looping forever', () => {
  assert.throws(() => chunkIds(ids(3), 0), /size must be positive/);
});

test('regression: a 40-check status page is fully covered, not cut at 25', () => {
  // The original bug: status pages allowed 50 checks but the batch query sliced to 25,
  // so checks 26-40 in sorted-id order rendered blank with no warning anywhere.
  const page = ids(40);
  const { ids: capped, notice } = capWebsiteIds(page, MAX_SUMMARY_WEBSITES);
  assert.equal(notice, null, 'a 40-check page must not be truncated at all');
  assert.equal(capped.length, 40);

  const covered = chunkIds(capped, SUMMARY_QUERY_CHUNK).flat();
  assert.deepEqual(covered, page);
  for (const id of page) {
    assert.ok(covered.includes(id), `${id} must reach a query`);
  }
});

test('the summary cap sits above any real status page', () => {
  // status-pages.ts caps a page at 50 checks; the summary path must clear that easily.
  assert.ok(MAX_SUMMARY_WEBSITES > 50);
});

test('capping under the limit is a no-op and reports nothing', () => {
  const input = ids(10);
  const { ids: capped, notice } = capWebsiteIds(input, 25);
  assert.deepEqual(capped, input);
  assert.equal(notice, null);
});

test('capping at exactly the limit does not report truncation', () => {
  const { notice } = capWebsiteIds(ids(25), 25);
  assert.equal(notice, null);
});

test('capping over the limit reports what was dropped', () => {
  const { ids: capped, notice } = capWebsiteIds(ids(40), 25);
  assert.equal(capped.length, 25);
  assert.deepEqual(notice, { requested: 40, limit: 25, dropped: 15 });
});
