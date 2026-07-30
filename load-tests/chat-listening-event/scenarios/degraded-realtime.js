import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("degraded-realtime", {
  maxVus: Number.parseInt(__ENV.LOAD_TEST_MAX_VUS || "100", 10),
  duration: __ENV.LOAD_TEST_DURATION || "5m",
  writeScenario: false,
});

export const options = constantOptions("degraded_realtime_recovery_poll", config, config.maxVus, config.duration);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "passive");
}

export const handleSummary = makeSummary(config);

