import { check, sleep } from "k6";
import { buildConfig } from "../lib/config.js";
import { setupScenario } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { rpc } from "../lib/supabase.js";

const config = buildConfig("pause-resume", { vus: 1, duration: "1m", writeScenario: false, adminScenario: true });

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  if (!config.adminWriteEnabled) {
    throw new Error("Set LOAD_TEST_ADMIN_WRITE_ENABLED=true and use authenticated/admin credentials only in staging before pause/resume testing.");
  }
  return setupScenario(config);
}

export default function() {
  const pause = rpc(config, "set_event_chat_auto_publish_settings", {
    p_event_id: config.eventId,
    p_auto_publish_enabled: null,
    p_queue_paused: true,
  }, { endpoint: "pause_queue" });
  check(pause, { "queue pause RPC accepted": r => r.status === 200 });
  sleep(5);
  const resume = rpc(config, "set_event_chat_auto_publish_settings", {
    p_event_id: config.eventId,
    p_auto_publish_enabled: null,
    p_queue_paused: false,
  }, { endpoint: "resume_queue" });
  check(resume, { "queue resume RPC accepted": r => r.status === 200 });
}

export const handleSummary = makeSummary(config);
