import { existsSync, readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

const base = "load-tests/chat-listening-event";
const requiredFiles = [
  `${base}/README.md`,
  `${base}/.env.example`,
  `${base}/lib/config.js`,
  `${base}/lib/supabase.js`,
  `${base}/lib/listener.js`,
  `${base}/lib/metrics.js`,
  `${base}/lib/random.js`,
  `${base}/lib/summary.js`,
  `${base}/scenarios/dry-run.js`,
  `${base}/scenarios/smoke.js`,
  `${base}/scenarios/ramp.js`,
  `${base}/scenarios/passive-10k.js`,
  `${base}/scenarios/mixed-10k.js`,
  `${base}/scenarios/peak-10k.js`,
  `${base}/scenarios/rate-limit.js`,
  `${base}/scenarios/queue.js`,
  `${base}/scenarios/scheduler-concurrency.js`,
  `${base}/scenarios/pause-resume.js`,
  `${base}/scenarios/soak-short.js`,
  `${base}/scenarios/soak-8h.js`,
  `${base}/tools/provision-participants.mjs`,
  `${base}/tools/cleanup-test-messages.mjs`,
  `${base}/sql/diagnostics.sql`,
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing load-test file: ${file}`);
}

const config = read(`${base}/lib/config.js`);
assert(config.includes("LOAD_TEST_CONFIRMED") && config.includes("I_UNDERSTAND_THIS_LOAD_TEST"), "Large/write scenarios must require explicit confirmation.");
assert(config.includes("LOAD_TEST_PRODUCTION_OVERRIDE") && config.includes("AUTHORIZED_PRODUCTION_LOAD_TEST"), "Production-like targets must require explicit production override.");
assert(config.includes("LOAD_TEST_WRITE_ENABLED") && config.includes("writeScenario"), "Write scenarios must require write enablement.");
assert(config.includes("LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY") && config.includes('LOAD_TEST_AUTH_MODE=service'), "Internal worker scenarios must require explicit service-role staging configuration.");
assert(config.includes("LOAD_TEST_REALTIME_ENABLED") && config.includes("reserved for a future Supabase Realtime protocol scenario"), "Realtime limitation must fail loudly rather than silently pretending to simulate WebSocket subscriptions.");

const supabase = read(`${base}/lib/supabase.js`);
assert(supabase.includes('rpc(config, "join_event_chat"') && supabase.includes("p_session_id: sessionId"), "Load tests must use the real join_event_chat RPC.");
assert(supabase.includes('rpc(config, "submit_chat_message"') && supabase.includes("p_participant_id") && supabase.includes("p_session_id") && supabase.includes("p_client_token"), "Load tests must use the secure five-argument submit RPC.");
assert(supabase.includes('rpc(config, "get_visitor_visible_chat_message_delta"') && supabase.includes("p_after_published_at") && supabase.includes("p_after_public_updated_at") && supabase.includes("verifyNoQueuedLeak"), "Load tests must use cutoff-aware visitor deltas and visibility-leak checks.");
assert(!supabase.includes("service_role") && !supabase.includes("SERVICE_ROLE"), "k6 scenarios must not embed service-role access.");

const listener = read(`${base}/lib/listener.js`);
assert(listener.includes("pickProfile") && listener.includes("maybePeakSubmit") && listener.includes("weightedDelayInWindow"), "Listener model must include configurable profiles and weighted peak submissions.");
assert(listener.includes("verifySenderPrivateVisible") && listener.includes("verifyNoQueuedLeak"), "Smoke/submit paths must verify sender-private visibility and no queued cross-participant leak.");

const diagnostics = read(`${base}/sql/diagnostics.sql`);
assert(diagnostics.includes("cron.job") && diagnostics.includes("queue_publications_last_minute") && diagnostics.includes("pg_stat_user_indexes"), "Diagnostics SQL must cover cron, queue publication rate, and index usage.");
assert(diagnostics.includes("explain (analyze, buffers)") && diagnostics.includes("do not run against production"), "Staging-only EXPLAIN ANALYZE guidance must remain explicit.");

const readme = read(`${base}/README.md`);
assert(readme.includes("Vite + React, not Next.js"), "README must report the framework mismatch discovered during inspection.");
assert(readme.includes("Supabase Realtime WebSocket protocol is not simulated"), "README must document the Realtime simulation limitation.");
assert(readme.includes("Do not run production tests"), "README must contain production safety guidance.");

console.log("load-test suite checks passed");
