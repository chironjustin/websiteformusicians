import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

const schema = read("supabase/chat-schema.sql");
const migration = read("supabase/chat-visitor-message-delta.sql");
const hook = read("src/hooks/useEventChat.ts");
const service = read("src/services/chatService.ts");
const types = read("src/types/chat.ts");
const immutabilityMigration = read("supabase/chat-publication-timestamp-immutability.sql");

for (const sql of [schema, migration]) {
  assert(sql.includes("verified_participant as") && sql.includes("event_chat_participants.id = p_participant_id") && sql.includes("event_chat_participants.session_id = p_session_id"), "Delta RPC must verify event, participant, and session inside the database.");
  assert(sql.includes("active_pin as") && sql.includes("chat_messages.is_pinned = true") && sql.includes("chat_messages.published_at >= verified_participant.joined_at"), "Active pin must not expose pre-join messages.");
  assert(sql.includes("public_new_delta as") && sql.includes("chat_messages.published_at >= verified_participant.joined_at"), "Public-new stream must enforce joined_at.");
  assert(sql.includes("public_update_delta as") && sql.includes("chat_messages.published_at >= verified_participant.joined_at") && sql.includes("p_after_public_updated_at is not null"), "Public-update stream must enforce joined_at and never bootstrap visibility.");
  assert(sql.includes("private_delta as") && sql.includes("chat_messages.participant_id = p_participant_id"), "Private stream must be scoped to the verified participant.");
  assert(sql.includes("chat_messages.published_at > p_after_published_at") && sql.includes("chat_messages.published_at = p_after_published_at") && sql.includes("chat_messages.id > p_after_id"), "Public-new stream must use tuple-equivalent published_at/id cursor semantics.");
  assert(sql.includes("chat_messages.updated_at > p_after_public_updated_at") && sql.includes("chat_messages.updated_at = p_after_public_updated_at") && sql.includes("chat_messages.id > p_after_public_updated_id"), "Public-update stream must use tuple-equivalent updated_at/id cursor semantics.");
  assert(sql.includes("chat_messages.updated_at > p_after_private_updated_at") && sql.includes("chat_messages.updated_at = p_after_private_updated_at") && sql.includes("chat_messages.id > p_after_private_id"), "Private stream must use tuple-equivalent updated_at/id cursor semantics.");
  assert(sql.includes("order by\n      chat_messages.published_at asc,\n      chat_messages.id asc"), "Public-new ORDER BY must exactly match the publication cursor.");
  assert(sql.includes("order by\n      chat_messages.updated_at asc,\n      chat_messages.id asc"), "Update/private ORDER BY must match update cursors.");
  assert(sql.includes("union all\n    select * from public_new_delta") && !sql.includes("distinct on (merged.id)"), "Delta RPC must preserve per-stream rows so pagination can be decided per stream.");
}

assert(types.includes('"active_pin" | "public_new" | "public_update" | "own"'), "Frontend type must preserve stream identity.");
assert(service.includes("p_after_public_updated_at") && service.includes("p_after_public_updated_id"), "Service must pass the public update cursor to the RPC.");
assert(hook.includes("mergeDeltaMessages") && hook.includes('message.visibility_scope !== "public_update"'), "Hook must not let public-update rows create first visibility.");
assert(hook.includes('message.visibility_scope === "public_new"') && hook.includes("publicCursorRef.current = { publishedAt: message.published_at, id: message.id }"), "Hook must advance public cursor only from public-new rows.");
assert(hook.includes('message.visibility_scope === "public_update"') && hook.includes("publicUpdateCursorRef.current = { updatedAt: message.updated_at, id: message.id }"), "Hook must advance public update cursor only from public-update rows.");
assert(hook.includes('message.visibility_scope === "own"') && hook.includes("privateCursorRef.current = { updatedAt: message.updated_at, id: message.id }"), "Hook must advance private cursor only from own rows.");
assert(hook.includes("countDeltaScope(deltaMessages, \"public_new\")") && hook.includes("countDeltaScope(deltaMessages, \"public_update\")") && hook.includes("countDeltaScope(deltaMessages, \"own\")"), "Hook must continue pagination independently by stream.");
assert(hook.includes("applyActivePinSnapshot") && hook.includes("activePinIds"), "Hook must apply active pin as an authoritative snapshot and clear stale pins.");
assert(hook.includes("fetchingDeltaRef.current") && hook.includes("pendingDeltaRef.current"), "Hook must serialize overlapping realtime and safety-poll fetches.");
assert(hook.includes("scopeGenerationRef") && hook.includes("scopeGenerationRef.current !== generation"), "Hook must reject stale delayed responses after event/viewer changes.");
assert(!hook.includes("Date.now()") && !hook.includes("new Date().toISOString()"), "Hook must not invent cursor timestamps from browser time.");
assert(schema.includes("old.status is distinct from 'approved'") && schema.includes("new.published_at := old.published_at"), "Canonical schema must assign published_at only on approval and preserve it on approved-row updates.");
assert(immutabilityMigration.includes("old.status is distinct from 'approved'") && immutabilityMigration.includes("new.published_at := old.published_at"), "Forward-only immutability migration must harden published_at assignment.");

console.log("chat delta cursor checks passed");
