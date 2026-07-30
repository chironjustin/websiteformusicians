import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateWorkload, parseArgs, printPreflight, readJson, validateStageRequest } from "../helpers/load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stages = readJson(resolve(root, "config/stages.json"));
const scenarios = readJson(resolve(root, "config/scenarios.json"));
const args = parseArgs();
const context = validateStageRequest({ args: { ...args, "dry-run": true }, stages, scenarios, allowDryRun: true });
const estimate = estimateWorkload(context);

printPreflight(context);

const outDir = resolve(root, "reports");
mkdirSync(outDir, { recursive: true });
const manifestPath = resolve(outDir, `${context.runId}-${context.stageKey}-${context.scenario}-plan.json`);
writeFileSync(manifestPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  context,
  estimate,
  note: "Setup dry-run only. No participants were created and no network calls were made.",
}, null, 2));

console.log(`Wrote run plan: ${manifestPath}`);

