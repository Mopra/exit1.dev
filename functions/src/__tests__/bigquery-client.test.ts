import test from "node:test";
import assert from "node:assert/strict";
import { BigQuery } from "@google-cloud/bigquery";

import { createBigQuery, DEFAULT_MAX_BYTES_BILLED } from "../bigquery-client";

// Capture what the capped client hands to the real one, without a network call.
function captureQuery(): { seen: unknown[]; restore: () => void } {
  const seen: unknown[] = [];
  const original = BigQuery.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigQuery.prototype as any).query = function (q: unknown) { seen.push(q); return Promise.resolve([[]]); };
  return { seen, restore: () => { BigQuery.prototype.query = original; } };
}

test("queries without a cap get the default", async () => {
  const c = captureQuery();
  try {
    await createBigQuery().query({ query: "SELECT 1", params: { a: 1 } });
    await createBigQuery().query("SELECT 2");
    assert.deepEqual(c.seen, [
      { query: "SELECT 1", params: { a: 1 }, maximumBytesBilled: DEFAULT_MAX_BYTES_BILLED },
      { query: "SELECT 2", maximumBytesBilled: DEFAULT_MAX_BYTES_BILLED },
    ]);
  } finally {
    c.restore();
  }
});

test("an explicit cap and dry runs are left alone", async () => {
  const c = captureQuery();
  try {
    await createBigQuery().query({ query: "SELECT 1", maximumBytesBilled: "42" });
    await createBigQuery().query({ query: "SELECT 1", dryRun: true });
    assert.deepEqual(c.seen, [
      { query: "SELECT 1", maximumBytesBilled: "42" },
      { query: "SELECT 1", dryRun: true },
    ]);
  } finally {
    c.restore();
  }
});
