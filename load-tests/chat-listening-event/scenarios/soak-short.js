import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("soak-short", { maxVus: 1000, duration: "60m", writeScenario: true, largeScenario: true });
export const options = scenarioOptions("soak_short", config, [
  { duration: "10m", target: config.maxVus },
  { duration: config.duration, target: config.maxVus },
  { duration: "5m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "mixed");
}

export const handleSummary = makeSummary(config);
