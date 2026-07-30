import { check } from "k6";
import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { joinChat, submitMessage, verifyNoQueuedLeak, verifySenderPrivateVisible } from "../lib/supabase.js";
import { messageBody, uuidv4 } from "../lib/random.js";

const config = buildConfig("sender-private", { vus: 10, duration: "2m", writeScenario: true });
export const options = constantOptions("sender_private", config, Math.min(config.maxVus, 50), config.duration);

export function setup() {
  return setupScenario(config);
}

export default function() {
  const sender = joinChat(config, uuidv4());
  const other = joinChat(config, uuidv4());
  const result = submitMessage(config, sender, messageBody(config.runId, __VU, __ITER, "sender private"));
  check(result, { "sender-private submission accepted": value => value.accepted === true });
  if (result.accepted) {
    verifySenderPrivateVisible(config, sender, result.message);
    verifyNoQueuedLeak(config, other, result.message);
  }
}

export const handleSummary = makeSummary(config);

