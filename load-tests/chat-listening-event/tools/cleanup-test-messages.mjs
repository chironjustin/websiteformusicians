const CONFIRMATION = "DELETE_SYNTHETIC_LOAD_TEST_MESSAGES";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

const supabaseUrl = env("LOAD_TEST_SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = env("LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY");
const eventId = env("LOAD_TEST_EVENT_ID");
const runId = env("LOAD_TEST_RUN_ID");
const confirmed = env("LOAD_TEST_CLEANUP_CONFIRMED");
const environment = env("LOAD_TEST_ENVIRONMENT");

if (!supabaseUrl || !serviceRoleKey || !eventId || !runId) {
  throw new Error("Missing LOAD_TEST_SUPABASE_URL, LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY, LOAD_TEST_EVENT_ID, or LOAD_TEST_RUN_ID.");
}

if (!["staging", "load-test"].includes(environment.toLowerCase())) {
  throw new Error("Cleanup requires LOAD_TEST_ENVIRONMENT=staging or load-test.");
}

if (confirmed !== CONFIRMATION) {
  throw new Error(`Refusing cleanup without LOAD_TEST_CLEANUP_CONFIRMED=${CONFIRMATION}.`);
}

const headers = {
  "Content-Type": "application/json",
  "apikey": serviceRoleKey,
  "Authorization": `Bearer ${serviceRoleKey}`,
  "Prefer": "return=representation",
};

const url = `${supabaseUrl}/rest/v1/chat_messages?event_id=eq.${encodeURIComponent(eventId)}&body=ilike.*${encodeURIComponent(runId)}*&select=id,body,status,created_at`;
const response = await fetch(url, { method: "DELETE", headers });
const payload = await response.json().catch(() => []);
if (!response.ok) {
  throw new Error(`Cleanup failed: ${response.status} ${JSON.stringify(payload)}`);
}

console.log(`Deleted ${Array.isArray(payload) ? payload.length : 0} synthetic chat_messages for run ${runId}.`);
console.log("Participant rows were intentionally left intact because they represent permanent chat admissions.");
