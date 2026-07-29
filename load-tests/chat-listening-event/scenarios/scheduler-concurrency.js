import { check } from "k6";
import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { rpc } from "../lib/supabase.js";
import { queueWorkerDuration } from "../lib/metrics.js";

const config = buildConfig("scheduler-concurrency", { vus: 2, duration: "1m", writeScenario: false, largeScenario: false, adminScenario: true });
export const options = constantOptions("scheduler_concurrency", config, 2, config.duration);

export function setup() {
  if (!config.controlledWorkerEnabled) {
    throw new Error("Set LOAD_TEST_WORKER_INVOCATION_ENABLED=true in a safe staging database before invoking worker RPCs.");
  }
  return setupScenario(config);
}

export default function() {
  const started = Date.now();
  const res = rpc(config, "process_chat_publish_queue", { p_event_id: config.eventId }, { endpoint: "queue_worker" });
  queueWorkerDuration.add(Date.now() - started);
  check(res, { "worker invocation completed": r => r.status === 200 });
}

export const handleSummary = makeSummary(config);
