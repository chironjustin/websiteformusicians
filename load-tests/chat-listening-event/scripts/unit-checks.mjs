import assert from "node:assert/strict";
import { advanceCursors, assertNoPreJoinMessages, compareTuple, mergeById } from "../helpers/cursors.mjs";

assert.equal(compareTuple("2026-01-01T00:00:00.000Z", "00000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z", "00000000-0000-4000-8000-000000000000"), 1);
assert.equal(compareTuple("2026-01-01T00:00:01.000Z", "a", "2026-01-01T00:00:02.000Z", "a"), -1);

const joinedAt = "2026-01-01T00:00:05.000Z";
assert.equal(assertNoPreJoinMessages([
  { visibility_scope: "public_new", published_at: "2026-01-01T00:00:05.000Z" },
  { visibility_scope: "own", published_at: "2026-01-01T00:00:00.000Z" },
], joinedAt), true);
assert.equal(assertNoPreJoinMessages([
  { visibility_scope: "public_new", published_at: "2026-01-01T00:00:04.999Z" },
], joinedAt), false);

const merged = mergeById(
  [{ id: "1", body: "old", published_at: "2026-01-01T00:00:06.000Z" }],
  [{ id: "1", body: "new", published_at: "2026-01-01T00:00:06.000Z" }, { id: "2", body: "second", published_at: "2026-01-01T00:00:07.000Z" }],
);
assert.equal(merged.length, 2);
assert.equal(merged[0].body, "new");

const state = {};
advanceCursors(state, [
  { id: "00000000-0000-4000-8000-000000000002", visibility_scope: "public_new", status: "approved", published_at: "2026-01-01T00:00:06.000Z" },
  { id: "00000000-0000-4000-8000-000000000001", visibility_scope: "public_update", updated_at: "2026-01-01T00:00:07.000Z" },
  { id: "00000000-0000-4000-8000-000000000003", visibility_scope: "own", participant_id: "p1", updated_at: "2026-01-01T00:00:08.000Z" },
], "p1", joinedAt);
assert.equal(state.publicCursor.id, "00000000-0000-4000-8000-000000000002");
assert.equal(state.publicUpdateCursor.id, "00000000-0000-4000-8000-000000000001");
assert.equal(state.privateCursor.id, "00000000-0000-4000-8000-000000000003");

console.log("load-test unit checks passed");

