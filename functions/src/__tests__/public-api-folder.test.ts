import test from "node:test";
import assert from "node:assert/strict";

import {
  compareByOrder,
  folderMatches,
  folderRange,
  normalizeFolderParam,
  pageInMemory,
} from "../public-api-folder";

test("normalizeFolderParam trims slashes and collapses separators", () => {
  assert.equal(normalizeFolderParam("/Personal//Radio/"), "Personal/Radio");
  assert.equal(normalizeFolderParam("Personal\\Radio"), "Personal/Radio");
  assert.equal(normalizeFolderParam("  "), null);
  assert.equal(normalizeFolderParam(undefined), null);
});

test("folderRange covers the folder and its subfolders", () => {
  const { start, end } = folderRange("Personal/Radio");
  for (const f of ["Personal/Radio", "Personal/Radio/Live", "Personal/Radio/a/b"]) {
    assert.ok(f >= start && f < end, f);
  }
  for (const f of ["Personal", "Personal/RadioX", "Personal/Rad", "Work/Radio"]) {
    assert.ok(!(f >= start && f < end), f);
  }
});

test("folderMatches: exact by default, subfolders when recursive", () => {
  assert.ok(folderMatches("Personal/Radio", "Personal/Radio", false));
  assert.ok(!folderMatches("Personal/Radio/Live", "Personal/Radio", false));
  assert.ok(folderMatches("Personal/Radio/Live", "Personal/Radio", true));
  // Inside the Firestore range but a sibling, not a subfolder.
  assert.ok(!folderMatches("Personal/Radio-old", "Personal/Radio", true));
  assert.ok(!folderMatches(null, "Personal/Radio", true));
  assert.ok(folderMatches("/Personal/Radio/", "Personal/Radio", false));
});

test("pageInMemory pages by number and by cursor in list order", () => {
  const rows = [
    { id: "c", orderIndex: 2 },
    { id: "a", orderIndex: 1 },
    { id: "b", orderIndex: 1 },
    { id: "d", orderIndex: 3 },
  ].sort(compareByOrder);
  assert.deepEqual(rows.map(r => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(pageInMemory(rows, { limit: 2, page: 2, cursor: null }).map(r => r.id), ["c", "d"]);
  assert.deepEqual(pageInMemory(rows, { limit: 2, page: 1, cursor: { orderIndex: 1, id: "b" } }).map(r => r.id), ["c", "d"]);
  assert.deepEqual(pageInMemory(rows, { limit: 2, page: 1, cursor: { orderIndex: 3, id: "d" } }), []);
});
