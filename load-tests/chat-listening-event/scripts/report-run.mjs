import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, parseArgs } from "../helpers/load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs();
const runId = env("LOAD_TEST_RUN_ID") || args["run-id"];
if (!runId) throw new Error("Provide LOAD_TEST_RUN_ID or --run-id=<runId>.");

const resultsDir = resolve(root, "results");
const reportsDir = resolve(root, "reports");
mkdirSync(reportsDir, { recursive: true });

const summaries = existsSync(resultsDir)
  ? readdirSync(resultsDir)
    .filter(file => file.startsWith(runId) && file.endsWith(".json"))
    .map(file => JSON.parse(readFileSync(resolve(resultsDir, file), "utf8")))
  : [];

const lines = [
  `# Load-test report: ${runId}`,
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  summaries.length === 0 ? "No k6 JSON summaries were found for this run." : `Summaries found: ${summaries.length}`,
  "",
  "| Scenario | Environment | HTTP requests | HTTP failure rate | Delta p95 | Accepted submissions | Visibility leaks | Duplicates |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
];

for (const summary of summaries) {
  const metrics = summary.metrics || {};
  lines.push([
    summary.scenario || "unknown",
    summary.environment || "unknown",
    metric(metrics, "http_reqs", "count"),
    metric(metrics, "http_req_failed", "rate"),
    metric(metrics, "public_message_fetch_duration", "p(95)"),
    metric(metrics, "accepted_submissions", "count"),
    metric(metrics, "visibility_leak", "count"),
    metric(metrics, "duplicate_public_delivery", "count"),
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
}

lines.push(
  "",
  "## Operator checklist",
  "",
  "- Attach Supabase dashboard screenshots for database CPU, memory, connection pool, Realtime connections, and API egress.",
  "- Record whether the next concurrency stage is approved.",
  "- Do not proceed after threshold failures without investigation.",
);

const out = resolve(reportsDir, `${runId}-comparison.md`);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Wrote ${out}`);

function metric(metrics, name, key) {
  return metrics[name]?.values?.[key] ?? "n/a";
}
