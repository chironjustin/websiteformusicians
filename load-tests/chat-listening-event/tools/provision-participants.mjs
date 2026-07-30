import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const CONFIRMATION = "I_UNDERSTAND_THIS_LOAD_TEST";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const supabaseUrl = env("LOAD_TEST_SUPABASE_URL").replace(/\/+$/, "");
const anonKey = env("LOAD_TEST_SUPABASE_ANON_KEY");
const eventId = env("LOAD_TEST_EVENT_ID");
const environment = env("LOAD_TEST_ENVIRONMENT");
const confirmed = env("LOAD_TEST_CONFIRMED");
const generationEnabled = env("LOAD_TEST_PARTICIPANT_GENERATION_ENABLED") === "true";
const count = Number.parseInt(arg("count", "10"), 10);
const out = arg("out", `load-tests/chat-listening-event/results/provisioned-${Date.now()}.json`);

if (!supabaseUrl || !anonKey || !eventId || !environment) {
  throw new Error("Missing LOAD_TEST_SUPABASE_URL, LOAD_TEST_SUPABASE_ANON_KEY, LOAD_TEST_EVENT_ID, or LOAD_TEST_ENVIRONMENT.");
}

if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`Invalid --count value: ${count}`);
}

if (count > 100 && confirmed !== CONFIRMATION) {
  throw new Error(`Refusing to provision ${count} participants without LOAD_TEST_CONFIRMED=${CONFIRMATION}.`);
}

if (!["staging", "load-test"].includes(environment.toLowerCase())) {
  throw new Error("Participant provisioning requires LOAD_TEST_ENVIRONMENT=staging or load-test.");
}

if (!generationEnabled) {
  throw new Error("Set LOAD_TEST_PARTICIPANT_GENERATION_ENABLED=true only for a dedicated load-test fixture event.");
}

const headers = {
  "Content-Type": "application/json",
  "apikey": anonKey,
  "Authorization": `Bearer ${anonKey}`,
};

const participants = [];
for (let index = 0; index < count; index += 1) {
  const sessionId = randomUUID();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/join_event_chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_event_id: eventId,
      p_session_id: sessionId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`join_event_chat failed at ${index}: ${response.status} ${JSON.stringify(payload)}`);
  }
  const row = Array.isArray(payload) ? payload[0] : payload;
  participants.push({
    eventId,
    participantId: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    joinedAt: row.joined_at,
  });
}

writeFileSync(out, JSON.stringify({
  environment,
  eventId,
  createdAt: new Date().toISOString(),
  count: participants.length,
  participants,
}, null, 2));

console.log(`Provisioned ${participants.length} participants through join_event_chat.`);
console.log(`Wrote ${out}. Keep this file local; it contains session IDs.`);
