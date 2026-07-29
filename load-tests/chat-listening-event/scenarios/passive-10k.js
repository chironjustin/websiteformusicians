import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("passive-10k", { maxVus: 10000, duration: "15m", writeScenario: false, largeScenario: true });

export const options = scenarioOptions("passive_10k", config, [
  { duration: "15m", target: config.maxVus },
  { duration: config.duration, target: config.maxVus },
  { duration: "3m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "passive");
}

export const handleSummary = makeSummary(config);
