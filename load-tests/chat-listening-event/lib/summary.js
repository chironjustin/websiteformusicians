export function makeSummary(config) {
  return function handleSummary(data) {
    const runId = config.runId || "unknown-run";
    const summary = {
      runId,
      scenario: config.scenarioName,
      environment: config.environment,
      baseUrl: config.baseUrl,
      eventId: config.eventId,
      startedAt: new Date(data.state.testRunDurationMs ? Date.now() - data.state.testRunDurationMs : Date.now()).toISOString(),
      endedAt: new Date().toISOString(),
      metrics: data.metrics,
      rootGroup: data.root_group,
      thresholds: data.thresholds,
    };

    return {
      stdout: humanSummary(summary),
      [`load-tests/chat-listening-event/results/${runId}-${config.scenarioName}.json`]: JSON.stringify(summary, null, 2),
      [`load-tests/chat-listening-event/results/${runId}-${config.scenarioName}.csv`]: csvSummary(summary),
    };
  };
}

function humanSummary(summary) {
  const metrics = summary.metrics || {};
  const lines = [
    "",
    "Live chat load-test summary",
    `run: ${summary.runId}`,
    `scenario: ${summary.scenario}`,
    `environment: ${summary.environment}`,
    `event: ${summary.eventId}`,
    metricLine(metrics, "http_reqs", "HTTP requests"),
    metricLine(metrics, "http_req_failed", "HTTP failure rate"),
    metricLine(metrics, "heartbeat_duration", "Heartbeat duration"),
    metricLine(metrics, "submission_duration", "Submission duration"),
    metricLine(metrics, "accepted_submissions", "Accepted submissions"),
    metricLine(metrics, "intentional_rate_limit_rejections", "Intentional rate-limit rejections"),
    metricLine(metrics, "unexpected_submission_rejections", "Unexpected submission rejections"),
    metricLine(metrics, "visibility_leak", "Queued visibility leaks"),
    metricLine(metrics, "duplicate_public_delivery", "Duplicate public deliveries"),
    "",
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}

function metricLine(metrics, name, label) {
  const metric = metrics[name];
  if (!metric) return `${label}: n/a`;
  const values = metric.values || {};
  if (values.count !== undefined) return `${label}: count=${values.count}`;
  if (values.rate !== undefined) return `${label}: rate=${values.rate}`;
  return `${label}: p95=${values["p(95)"] ?? "n/a"} p99=${values["p(99)"] ?? "n/a"} avg=${values.avg ?? "n/a"}`;
}

function csvSummary(summary) {
  const rows = [["metric", "value_name", "value"]];
  for (const [metricName, metric] of Object.entries(summary.metrics || {})) {
    for (const [valueName, value] of Object.entries(metric.values || {})) {
      rows.push([metricName, valueName, String(value)]);
    }
  }
  return rows.map(row => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
