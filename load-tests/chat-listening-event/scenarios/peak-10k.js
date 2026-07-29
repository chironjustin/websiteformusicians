import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("peak-10k", { maxVus: 10000, duration: "20m", writeScenario: true, largeScenario: true });

export const options = scenarioOptions("peak_10k", config, [
  { duration: "15m", target: config.maxVus },
  { duration: config.duration, target: config.maxVus },
  { duration: "5m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "peak");
}

export const handleSummary = makeSummary(config);
