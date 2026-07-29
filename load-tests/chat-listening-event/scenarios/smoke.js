import { sleep } from "k6";
import { check } from "k6";
import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { joinChat, submitMessage, verifyNoQueuedLeak, verifySenderPrivateVisible } from "../lib/supabase.js";
import { messageBody, uuidv4 } from "../lib/random.js";

const config = buildConfig("smoke", { vus: 10, duration: "5m", writeScenario: true });
export const options = constantOptions("smoke", config, 10, config.duration);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "mixed");
}

export function teardown(data) {
  const sender = joinChat(config, uuidv4());
  const other = joinChat(config, uuidv4());
  const result = submitMessage(config, sender, messageBody(config.runId, 0, 0, "smoke sender private"));
  check(result, { "smoke controlled submission accepted": value => value.accepted === true });
  if (result.accepted) {
    verifySenderPrivateVisible(config, sender, result.message);
    verifyNoQueuedLeak(config, other, result.message);
  }
  sleep(1);
}

export const handleSummary = makeSummary(config);
