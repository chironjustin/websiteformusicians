import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("mixed-10k", { maxVus: 10000, duration: "30m", writeScenario: true, largeScenario: true });

export const options = scenarioOptions("mixed_10k", config, [
  { duration: "20m", target: config.maxVus },
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
