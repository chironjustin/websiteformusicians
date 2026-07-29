import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario, rateLimitIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";

const config = buildConfig("rate-limit", { vus: 3, duration: "3m", writeScenario: true });
export const options = constantOptions("rate_limit", config, 3, config.duration);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  rateLimitIteration(config, data);
}

export const handleSummary = makeSummary(config);
