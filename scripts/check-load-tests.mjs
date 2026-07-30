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
  "load-tests/.env.example",
  `${base}/config/stages.json`,
  `${base}/config/scenarios.json`,
  `${base}/helpers/load-env.mjs`,
  `${base}/helpers/cursors.mjs`,
  `${base}/lib/config.js`,
  `${base}/lib/supabase.js`,
  `${base}/lib/listener.js`,
  `${base}/lib/metrics.js`,
  `${base}/lib/random.js`,
  `${base}/lib/summary.js`,
  `${base}/scenarios/dry-run.js`,
  `${base}/scenarios/stage.js`,
  `${base}/scenarios/publication.js`,
  `${base}/scenarios/sender-private.js`,
  `${base}/scenarios/joined-boundary.js`,
  `${base}/scenarios/degraded-realtime.js`,
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
  `${base}/realtime/harness.mjs`,
  `${base}/scripts/run-load-test.mjs`,
  `${base}/scripts/setup-run.mjs`,
  `${base}/scripts/cleanup-run.mjs`,
  `${base}/scripts/report-run.mjs`,
  `${base}/scripts/unit-checks.mjs`,
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
assert(config.includes("LOAD_TEST_ALLOWED_HOST") && config.includes("LOAD_TEST_PARTICIPANT_GENERATION_ENABLED") && config.includes("LOAD_TEST_CONFIRM_HIGH_LOAD") && config.includes("LOAD_TEST_LOWER_STAGES_PASSED"), "k6 scenarios must enforce host, participant-generation, and high-load safety gates.");

const loadEnv = read(`${base}/helpers/load-env.mjs`);
assert(loadEnv.includes("LOAD_TEST_ENVIRONMENT must equal staging or load-test") && loadEnv.includes("LOAD_TEST_ALLOWED_HOST") && loadEnv.includes("High-load stages require LOAD_TEST_CONFIRM_HIGH_LOAD=true") && loadEnv.includes("LOAD_TEST_LOWER_STAGES_PASSED=true"), "Node control plane must refuse unsafe environments and high-load stages without explicit confirmations.");
assert(loadEnv.includes("estimatedBaselinePollingRps") && loadEnv.includes("estimatedOneMessageImmediateHerdRpcCalls"), "Dry-run must estimate polling volume and thundering-herd RPC volume.");

const packageJson = read("package.json");
assert(packageJson.includes('"load:test"') && packageJson.includes('"load:setup"') && packageJson.includes('"load:cleanup"') && packageJson.includes('"load:report"') && packageJson.includes('"load:unit"'), "Package scripts must expose the requested load-test command surface.");

const supabase = read(`${base}/lib/supabase.js`);
assert(supabase.includes('rpc(config, "join_event_chat"') && supabase.includes("p_session_id: sessionId"), "Load tests must use the real join_event_chat RPC.");
assert(supabase.includes('rpc(config, "submit_chat_message"') && supabase.includes("p_participant_id") && supabase.includes("p_session_id") && supabase.includes("p_client_token"), "Load tests must use the secure five-argument submit RPC.");
assert(supabase.includes('rpc(config, "get_visitor_visible_chat_message_delta"') && supabase.includes("p_after_published_at") && supabase.includes("p_after_public_updated_at") && supabase.includes("verifyNoQueuedLeak"), "Load tests must use cutoff-aware visitor deltas and visibility-leak checks.");
assert(supabase.includes("preJoinVisibilityViolation") && supabase.includes("deltaRpcCalls") && supabase.includes("zeroRowDeltaResponses"), "Load tests must measure delta RPC volume, zero-row responses, and joined_at leaks.");
assert(supabase.includes("insertAdminPublicMessage") && supabase.includes("controlled_publication") && supabase.includes("approval_source"), "Publication scenario must use a real gated admin-public message path for correlated fanout tests.");
assert(!supabase.includes("service_role") && !supabase.includes("SERVICE_ROLE"), "k6 scenarios must not embed service-role access.");

const listener = read(`${base}/lib/listener.js`);
assert(listener.includes("pickProfile") && listener.includes("maybePeakSubmit") && listener.includes("weightedDelayInWindow"), "Listener model must include configurable profiles and weighted peak submissions.");
assert(listener.includes("verifySenderPrivateVisible") && listener.includes("verifyNoQueuedLeak"), "Smoke/submit paths must verify sender-private visibility and no queued cross-participant leak.");

const diagnostics = read(`${base}/sql/diagnostics.sql`);
assert(diagnostics.includes("cron.job") && diagnostics.includes("queue_publications_last_minute") && diagnostics.includes("pg_stat_user_indexes"), "Diagnostics SQL must cover cron, queue publication rate, and index usage.");
assert(diagnostics.includes("pg_publication_tables") && diagnostics.includes("identical published_at") && diagnostics.includes("published_at < participant.joined_at"), "Diagnostics SQL must cover Realtime publication membership, cursor edge cases, and joined_at boundary inspection.");
assert(diagnostics.includes("explain (analyze, buffers)") && diagnostics.includes("do not run against production"), "Staging-only EXPLAIN ANALYZE guidance must remain explicit.");

const realtimeHarness = read(`${base}/realtime/harness.mjs`);
assert(realtimeHarness.includes("createClient") && realtimeHarness.includes("postgres_changes") && realtimeHarness.includes("SUBSCRIBED") && realtimeHarness.includes("get_visitor_visible_chat_message_delta"), "Realtime harness must use real Supabase channels and cursor-delta recovery.");
assert(realtimeHarness.includes("visibilityLeaks") && realtimeHarness.includes("deltaRpcCallsPerRealtimeWakeup") && realtimeHarness.includes("reconnect"), "Realtime harness must measure visibility safety, delta amplification, and reconnect behavior.");

const unitChecks = read(`${base}/scripts/unit-checks.mjs`);
assert(unitChecks.includes("compareTuple") && unitChecks.includes("assertNoPreJoinMessages") && unitChecks.includes("advanceCursors"), "Load-test unit checks must cover cursor tuple and joined_at validators.");

const readme = read(`${base}/README.md`);
assert(readme.includes("Vite + React") && readme.includes("Node Realtime harness") && readme.includes("k6 HTTP/RPC harness"), "README must report the inspected architecture and separated harnesses.");
assert(readme.includes("pnpm load:test --stage 100") && readme.includes("pnpm load:test --stage 10000 --confirm-high-load"), "README must document stage commands including high-load confirmation.");
assert(readme.includes("delta_rpc_calls_per_public_message") && readme.includes("published_at >= participant.joined_at"), "README must document thundering-herd metrics and joined_at correctness.");
assert(readme.includes("Do not run these tests against production"), "README must contain production safety guidance.");

console.log("load-test suite checks passed");
