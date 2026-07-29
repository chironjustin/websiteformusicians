import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("soak-8h", { maxVus: 10000, duration: "8h", writeScenario: true, largeScenario: true });
export const options = scenarioOptions("soak_8h", config, [
  { duration: "30m", target: config.maxVus },
  { duration: config.duration, target: config.maxVus },
  { duration: "10m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "mixed");
}

export const handleSummary = makeSummary(config);
