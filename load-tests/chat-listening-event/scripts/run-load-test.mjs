import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  estimateWorkload,
  k6ScenarioFor,
  parseArgs,
  printPreflight,
  readJson,
  validateStageRequest,
} from "../helpers/load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stages = readJson(resolve(root, "config/stages.json"));
const scenarios = readJson(resolve(root, "config/scenarios.json"));
const args = parseArgs();
const context = validateStageRequest({ args, stages, scenarios, allowDryRun: Boolean(args["dry-run"]) });

printPreflight(context);

if (context.dryRun) {
  console.log("Dry-run complete. No participants were created, no Realtime channels were opened, and no RPC requests were sent.");
  process.exit(0);
}

const env = {
  ...process.env,
  LOAD_TEST_BASE_URL: context.baseUrl,
  LOAD_TEST_TARGET_URL: context.targetUrl,
  LOAD_TEST_MAX_VUS: String(context.stage.concurrency),
  LOAD_TEST_DURATION: context.scenario === "idle" ? context.stage.idleDuration : context.stage.messageDuration,
  LOAD_TEST_STAGE: context.stageKey,
  LOAD_TEST_SCENARIO: context.scenario,
  LOAD_TEST_EXPECTED_WORKLOAD: JSON.stringify(estimateWorkload(context)),
};

if (context.runner === "realtime") {
  const result = spawnSync(process.execPath, [resolve(root, "realtime/harness.mjs"), "--stage", context.stageKey, "--scenario", context.scenario], {
    env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const scenarioPath = resolve(root, "scenarios", k6ScenarioFor(context));
const result = spawnSync("k6", ["run", scenarioPath], {
  env,
  stdio: "inherit",
});

if (result.error?.code === "ENOENT") {
  console.error("k6 was not found. Install it separately, then rerun this command. No load test was executed.");
  process.exit(1);
}

process.exit(result.status ?? 1);

