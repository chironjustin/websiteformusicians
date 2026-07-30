import { check, sleep } from "k6";
import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { fetchVisibleMessages, joinChat } from "../lib/supabase.js";
import { uuidv4 } from "../lib/random.js";
import { preJoinVisibilityViolation } from "../lib/metrics.js";

const config = buildConfig("joined-boundary", { vus: 10, duration: "2m", writeScenario: false });
export const options = constantOptions("joined_boundary", config, Math.min(config.maxVus, 50), config.duration);

export function setup() {
  return setupScenario(config);
}

export default function() {
  const identity = joinChat(config, uuidv4());
  sleep(1);
  const state = {};
  const messages = fetchVisibleMessages(config, identity, state, { verification: "joined_boundary" });
  const leaked = messages.some(message => (
    message.visibility_scope !== "own"
    && message.published_at
    && message.published_at < identity.joinedAt
  ));
  if (leaked) preJoinVisibilityViolation.add(1);
  check({ leaked }, { "no public messages before joined_at": value => !value.leaked });
}

export const handleSummary = makeSummary(config);

