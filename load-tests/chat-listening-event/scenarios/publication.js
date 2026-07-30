import { check, sleep } from "k6";
import { buildConfig, constantOptions } from "../lib/config.js";
import { setupScenario, listenerIteration } from "../lib/listener.js";
import { makeSummary } from "../lib/summary.js";
import { insertAdminPublicMessage } from "../lib/supabase.js";
import { messageBody } from "../lib/random.js";

const config = buildConfig("publication", {
  maxVus: Number.parseInt(__ENV.LOAD_TEST_MAX_VUS || "100", 10),
  duration: __ENV.LOAD_TEST_DURATION || "10m",
  writeScenario: true,
  adminScenario: Boolean(__ENV.LOAD_TEST_ADMIN_PUBLICATION_ENABLED === "true"),
  largeScenario: Number.parseInt(__ENV.LOAD_TEST_MAX_VUS || "100", 10) >= 5000,
});

export const options = config.adminPublicationEnabled
  ? {
    scenarios: {
      publication_observers: {
        executor: "constant-vus",
        vus: config.maxVus,
        duration: config.duration,
        gracefulStop: "30s",
      },
      controlled_publisher: {
        executor: "constant-vus",
        vus: 1,
        duration: config.duration,
        startTime: "30s",
        exec: "publisher",
        gracefulStop: "30s",
      },
    },
    thresholds: constantOptions("publication_observers", config, config.maxVus, config.duration).thresholds,
    summaryTrendStats: ["min", "avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  }
  : constantOptions("publication_observers", config, config.maxVus, config.duration);

export function setup() {
  return setupScenario(config);
}

export default function(data) {
  listenerIteration(config, data, "passive");
}

export function publisher() {
  const pattern = String(__ENV.LOAD_TEST_PUBLICATION_PATTERN || "10s");
  const sleepSeconds = pattern === "1s" ? 1 : pattern === "5s" ? 5 : 10;
  const body = messageBody(config.runId, 0, __ITER, `publication ${pattern}`);
  const res = insertAdminPublicMessage(config, body);
  check(res, { "publication insert completed": value => value.status >= 200 && value.status < 300 });
  sleep(sleepSeconds);
}

export const handleSummary = makeSummary(config);
