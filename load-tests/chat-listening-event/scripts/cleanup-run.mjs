import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../helpers/load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs();
const env = { ...process.env };
if (args["run-id"]) env.LOAD_TEST_RUN_ID = String(args["run-id"]);

const result = spawnSync(process.execPath, [resolve(root, "tools/cleanup-test-messages.mjs")], {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
