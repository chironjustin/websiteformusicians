import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("stage", {
  maxVus: Number.parseInt(__ENV.LOAD_TEST_MAX_VUS || "100", 10),
  duration: __ENV.LOAD_TEST_DURATION || "5m",
  writeScenario: __ENV.LOAD_TEST_SCENARIO !== "idle",
  largeScenario: Number.parseInt(__ENV.LOAD_TEST_MAX_VUS || "100", 10) >= 5000,
});

export const options = scenarioOptions("stage", config, [
  { duration: __ENV.LOAD_TEST_RAMP_UP || "5m", target: config.maxVus },
  { duration: config.duration, target: config.maxVus },
  { duration: __ENV.LOAD_TEST_RAMP_DOWN || "2m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  const behavior = config.scenarioKind === "idle" || !config.writeEnabled ? "passive" : "mixed";
  listenerIteration(config, data, behavior);
}

export const handleSummary = makeSummary(config);

