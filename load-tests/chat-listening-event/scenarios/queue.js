import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario, queueIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("queue", { vus: 100, duration: "10m", writeScenario: true });
export const options = constantOptions("queue_growth_drain", config, config.maxVus, config.duration);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  queueIteration(config, data);
}

export const handleSummary = makeSummary(config);
