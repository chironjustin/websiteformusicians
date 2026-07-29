import { buildConfig, scenarioOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("ramp", { maxVus: 10000, duration: "45m", writeScenario: true, largeScenario: true });

export const options = scenarioOptions("ramp", config, [
  { duration: "5m", target: 500 },
  { duration: "5m", target: 500 },
  { duration: "8m", target: 2500 },
  { duration: "5m", target: 2500 },
  { duration: "10m", target: 5000 },
  { duration: "5m", target: 5000 },
  { duration: "12m", target: config.maxVus },
  { duration: "10m", target: config.maxVus },
  { duration: "5m", target: 0 },
]);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "mixed");
}

export const handleSummary = makeSummary(config);
