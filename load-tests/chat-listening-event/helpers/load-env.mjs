import { readFileSync } from "node:fs";
import { URL } from "node:url";

export const CONFIRMATION = "I_UNDERSTAND_THIS_LOAD_TEST";
export const HIGH_LOAD_CONFIRMATION = "true";
export const PROD_OVERRIDE = "AUTHORIZED_PRODUCTION_LOAD_TEST";

const knownProductionHostPatterns = [
  /(^|\.)music-event-website\.vercel\.app$/i,
  /(^|\.)websiteformusicians\.com$/i,
  /(^|\.)musicforfans\.com$/i,
];

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function env(name, fallback = "") {
  return process.env[name] || fallback;
}

export function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(value);
}

export function durationSeconds(duration) {
  const match = String(duration || "").match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = Number.parseFloat(match[1]);
  if (match[2] === "h") return value * 3600;
  if (match[2] === "m") return value * 60;
  return value;
}

export function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export function supabaseProjectRef(supabaseUrl) {
  const host = safeHost(supabaseUrl);
  return host.endsWith(".supabase.co") ? host.split(".")[0] : host;
}

export function validateStageRequest({ args, stages, scenarios, allowDryRun = false }) {
  const stageKey = String(args.stage || "");
  if (!stages[stageKey]) {
    throw new Error(`Missing or invalid --stage. Expected one of: ${Object.keys(stages).join(", ")}.`);
  }

  const scenario = String(args.scenario || "idle");
  if (!scenarios[scenario]) {
    throw new Error(`Invalid --scenario=${scenario}. Expected one of: ${Object.keys(scenarios).join(", ")}.`);
  }

  const targetUrl = env("LOAD_TEST_TARGET_URL", env("LOAD_TEST_BASE_URL")).replace(/\/+$/, "");
  const baseUrl = env("LOAD_TEST_BASE_URL", targetUrl).replace(/\/+$/, "");
  const supabaseUrl = env("LOAD_TEST_SUPABASE_URL").replace(/\/+$/, "");
  const allowedHost = env("LOAD_TEST_ALLOWED_HOST");
  const eventId = env("LOAD_TEST_EVENT_ID");
  const environment = env("LOAD_TEST_ENVIRONMENT");
  const runId = env("LOAD_TEST_RUN_ID");
  const anonKey = env("LOAD_TEST_SUPABASE_ANON_KEY");
  const dryRun = Boolean(args["dry-run"] || allowDryRun);
  const stage = stages[stageKey];
  const scenarioConfig = scenarios[scenario];
  const targetHost = safeHost(targetUrl || baseUrl);

  if (!targetUrl && !baseUrl) throw new Error("Missing LOAD_TEST_TARGET_URL or LOAD_TEST_BASE_URL.");
  if (!supabaseUrl) throw new Error("Missing LOAD_TEST_SUPABASE_URL.");
  if (!anonKey) throw new Error("Missing LOAD_TEST_SUPABASE_ANON_KEY.");
  if (!allowedHost) throw new Error("Missing LOAD_TEST_ALLOWED_HOST.");
  if (!eventId) throw new Error("Missing LOAD_TEST_EVENT_ID.");
  if (!runId) throw new Error("Missing LOAD_TEST_RUN_ID.");
  if (!["staging", "load-test"].includes(environment.toLowerCase())) {
    throw new Error("LOAD_TEST_ENVIRONMENT must equal staging or load-test.");
  }
  if (targetHost !== allowedHost) {
    throw new Error(`Target host ${targetHost} does not match LOAD_TEST_ALLOWED_HOST=${allowedHost}.`);
  }
  if (knownProductionHostPatterns.some(pattern => pattern.test(targetHost))) {
    throw new Error(`Refusing known production host: ${targetHost}.`);
  }
  if (/prod/i.test(environment) && env("LOAD_TEST_PRODUCTION_OVERRIDE") !== PROD_OVERRIDE) {
    throw new Error("Production-like environment refused.");
  }
  if (!dryRun && env("LOAD_TEST_CONFIRMED") !== CONFIRMATION) {
    throw new Error(`Set LOAD_TEST_CONFIRMED=${CONFIRMATION} before running a real test.`);
  }
  if (!dryRun && !boolEnv("LOAD_TEST_PARTICIPANT_GENERATION_ENABLED")) {
    throw new Error("Set LOAD_TEST_PARTICIPANT_GENERATION_ENABLED=true for the dedicated staging fixture event.");
  }
  if (!dryRun && scenarioConfig.writes && !boolEnv("LOAD_TEST_WRITE_ENABLED")) {
    throw new Error(`Scenario ${scenario} writes data. Set LOAD_TEST_WRITE_ENABLED=true only for a dedicated staging/load-test event.`);
  }
  if (stage.requiresHighLoad) {
    if (env("LOAD_TEST_CONFIRM_HIGH_LOAD").toLowerCase() !== HIGH_LOAD_CONFIRMATION) {
      throw new Error("High-load stages require LOAD_TEST_CONFIRM_HIGH_LOAD=true.");
    }
    if (!args["confirm-high-load"]) {
      throw new Error("High-load stages require the --confirm-high-load argument.");
    }
    if (!boolEnv("LOAD_TEST_LOWER_STAGES_PASSED")) {
      throw new Error("High-load stages require LOAD_TEST_LOWER_STAGES_PASSED=true after lower-stage review.");
    }
  }
  if (stage.concurrency >= 10000 && args["confirm-high-load"] !== true && String(args["confirm-high-load"]) !== "true") {
    throw new Error("10,000-user stage requires the explicit --confirm-high-load flag.");
  }

  return {
    stageKey,
    stage,
    scenario,
    scenarioConfig,
    dryRun,
    targetUrl,
    baseUrl,
    targetHost,
    allowedHost,
    supabaseUrl,
    supabaseProjectRef: supabaseProjectRef(supabaseUrl),
    eventId,
    environment,
    runId,
    runner: args.runner || scenarioConfig.runner,
    rampProfile: args.profile || stage.rampProfile,
  };
}

export function estimateWorkload(context) {
  const pollSeconds = Number(context.stage.baselinePollSeconds || 10);
  const duration = context.scenario === "idle" ? context.stage.idleDuration : context.stage.messageDuration;
  const seconds = durationSeconds(duration);
  const clients = context.stage.concurrency;
  const pollingRps = clients / pollSeconds;
  const totalPollingRequests = Math.round(pollingRps * seconds);
  const joinRequests = clients;
  const listenerCountRequests = Math.ceil(clients * seconds / (pollSeconds * 20));
  return {
    duration,
    seconds,
    clients,
    realtimeConnections: clients,
    baselinePollingIntervalSeconds: pollSeconds,
    estimatedBaselinePollingRps: Number(pollingRps.toFixed(2)),
    estimatedPollingRequests: totalPollingRequests,
    estimatedJoinRequests: joinRequests,
    estimatedListenerCountRequests: listenerCountRequests,
    estimatedOneMessageImmediateHerdRpcCalls: clients,
    estimatedOneMessageWithPerfectCoalescingRpcCalls: clients,
    estimatedAudioDownloads: env("LOAD_TEST_AUDIO_PROBE_ENABLED") === "true" ? clients : 0,
  };
}

export function printPreflight(context) {
  const estimate = estimateWorkload(context);
  console.log(JSON.stringify({
    kind: context.dryRun ? "load-test-dry-run" : "load-test-preflight",
    runId: context.runId,
    environment: context.environment,
    targetHost: context.targetHost,
    supabaseProjectRef: context.supabaseProjectRef,
    eventId: context.eventId,
    stage: context.stageKey,
    scenario: context.scenario,
    runner: context.runner,
    rampProfile: context.rampProfile,
    highLoad: context.stage.requiresHighLoad,
    expected: estimate,
    phases: phasesFor(context),
    thresholds: defaultThresholds(),
  }, null, 2));
}

export function phasesFor(context) {
  if (context.scenario === "idle") {
    return [
      "validate environment and fixture event",
      "create or reuse synthetic participant sessions",
      "subscribe to Realtime where supported",
      "perform initial cursor-delta sync",
      "hold visible clients with recovery polling",
      "disconnect and summarize connection/RPC metrics",
    ];
  }
  if (context.scenario === "publication") {
    return [
      "establish connected listener cohort",
      "publish controlled correlated messages at configured rates",
      "measure notification-to-delta fanout and delivery latency",
      "verify no duplicates, missing messages, or joined_at leaks",
      "summarize delta_rpc_calls_per_public_message",
    ];
  }
  return [
    "validate environment and fixture event",
    `run ${context.scenario} behavior against synthetic participants`,
    "collect correctness and request metrics",
    "write JSON/CSV/Markdown report",
  ];
}

export function defaultThresholds() {
  return {
    connectionSuccessRate: ">= 99%",
    rpcErrorRate: "< 1%",
    unauthorizedVisibilityIncidents: "0",
    duplicatePublicMessages: "0",
    missingPublicMessages: "0 in correctness samples",
    staleScopeIncidents: "0",
    lowerStageP95DeltaRpcLatency: "< 1000ms",
    lowerStageP99DeltaRpcLatency: "< 3000ms",
    realtimeHealthyP95DeliveryLatency: "< 2000ms",
    abortSustainedErrorRate: "> 5%",
  };
}

export function k6ScenarioFor(context) {
  if (context.scenario === "sender-private") return "sender-private.js";
  if (context.scenario === "joined-boundary") return "joined-boundary.js";
  if (context.scenario === "degraded-realtime") return "degraded-realtime.js";
  if (context.scenario === "scope-switch") return "scope-switch.js";
  if (context.scenario === "publication") return "publication.js";
  return "stage.js";
}

