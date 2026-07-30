import { fail } from "k6";

const CONFIRMATION = "I_UNDERSTAND_THIS_LOAD_TEST";
const PRODUCTION_CONFIRMATION = "AUTHORIZED_PRODUCTION_LOAD_TEST";
const HIGH_LOAD_CONFIRMATION = "true";

export function getEnv(name, fallback = "") {
  const value = __ENV[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

export function getBool(name, fallback = false) {
  const value = getEnv(name, fallback ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(value);
}

export function getInt(name, fallback) {
  const raw = getEnv(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) fail(`Invalid integer for ${name}: ${raw}`);
  return value;
}

export function getFloat(name, fallback) {
  const raw = getEnv(name, String(fallback));
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) fail(`Invalid number for ${name}: ${raw}`);
  return value;
}

export function requireEnv(name) {
  const value = getEnv(name);
  if (!value) fail(`Missing required environment variable ${name}`);
  return value;
}

export function isProductionEnvironment(config) {
  const env = config.environment.toLowerCase();
  const base = config.baseUrl.toLowerCase();
  return env === "production" || env === "prod" || base.includes("vercel.app") && !env.includes("preview") && !env.includes("staging");
}

export function buildConfig(scenarioName, defaults) {
  const config = {
    scenarioName,
    baseUrl: requireEnv("LOAD_TEST_BASE_URL").replace(/\/+$/, ""),
    targetUrl: getEnv("LOAD_TEST_TARGET_URL", requireEnv("LOAD_TEST_BASE_URL")).replace(/\/+$/, ""),
    allowedHost: requireEnv("LOAD_TEST_ALLOWED_HOST"),
    supabaseUrl: requireEnv("LOAD_TEST_SUPABASE_URL").replace(/\/+$/, ""),
    supabaseAnonKey: requireEnv("LOAD_TEST_SUPABASE_ANON_KEY"),
    supabaseAccessToken: getEnv("LOAD_TEST_SUPABASE_ACCESS_TOKEN"),
    supabaseServiceRoleKey: getEnv("LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY"),
    adminUserId: getEnv("LOAD_TEST_ADMIN_USER_ID"),
    eventId: requireEnv("LOAD_TEST_EVENT_ID"),
    environment: requireEnv("LOAD_TEST_ENVIRONMENT"),
    authMode: getEnv("LOAD_TEST_AUTH_MODE", "anon"),
    writeEnabled: getBool("LOAD_TEST_WRITE_ENABLED", false),
    confirmed: getEnv("LOAD_TEST_CONFIRMED"),
    productionOverride: getEnv("LOAD_TEST_PRODUCTION_OVERRIDE"),
    runId: getEnv("LOAD_TEST_RUN_ID", `k6-${Date.now()}`),
    includePageLoad: getBool("LOAD_TEST_INCLUDE_PAGE_LOAD", true),
    includeAudioProbe: getBool("LOAD_TEST_AUDIO_PROBE_ENABLED", false),
    includeRealtime: getBool("LOAD_TEST_REALTIME_ENABLED", false),
    heartbeatIntervalSeconds: getFloat("LOAD_TEST_HEARTBEAT_INTERVAL_SECONDS", 3),
    messageFetchEvery: getInt("LOAD_TEST_MESSAGE_FETCH_EVERY", 1),
    messagePageLimit: getInt("LOAD_TEST_MESSAGE_PAGE_LIMIT", 200),
    maxVus: getInt("LOAD_TEST_MAX_VUS", defaults.vus ?? defaults.maxVus ?? 10),
    stage: getEnv("LOAD_TEST_STAGE", ""),
    scenarioKind: getEnv("LOAD_TEST_SCENARIO", scenarioName),
    duration: getEnv("LOAD_TEST_DURATION", defaults.duration ?? "5m"),
    writeScenario: defaults.writeScenario ?? false,
    largeScenario: defaults.largeScenario ?? false,
    adminScenario: defaults.adminScenario ?? false,
    allowProduction: defaults.allowProduction ?? false,
    passivePct: getFloat("LOAD_TEST_PASSIVE_PCT", 0.70),
    lightPct: getFloat("LOAD_TEST_LIGHT_PCT", 0.20),
    activePct: getFloat("LOAD_TEST_ACTIVE_PCT", 0.08),
    peakPct: getFloat("LOAD_TEST_PEAK_PCT", 0.02),
    peakFirstSubmitPct: getFloat("LOAD_TEST_PEAK_FIRST_SUBMIT_PCT", 0.10),
    peakSecondSubmitPct: getFloat("LOAD_TEST_PEAK_SECOND_SUBMIT_PCT", 0.03),
    peakThirdSubmitPct: getFloat("LOAD_TEST_PEAK_THIRD_SUBMIT_PCT", 0.01),
    peakWindowSeconds: getFloat("LOAD_TEST_PEAK_WINDOW_SECONDS", 30),
    peakStartsAfterSeconds: getFloat("LOAD_TEST_PEAK_STARTS_AFTER_SECONDS", 120),
    expectedRateLimitCode: getEnv("LOAD_TEST_RATE_LIMIT_CODE", "MESSAGE_RATE_LIMITED"),
    controlledWorkerEnabled: getBool("LOAD_TEST_WORKER_INVOCATION_ENABLED", false),
    adminWriteEnabled: getBool("LOAD_TEST_ADMIN_WRITE_ENABLED", false),
    adminPublicationEnabled: getBool("LOAD_TEST_ADMIN_PUBLICATION_ENABLED", false),
    participantGenerationEnabled: getBool("LOAD_TEST_PARTICIPANT_GENERATION_ENABLED", false),
    confirmHighLoad: getEnv("LOAD_TEST_CONFIRM_HIGH_LOAD"),
    lowerStagesPassed: getBool("LOAD_TEST_LOWER_STAGES_PASSED", false),
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!["anon", "authenticated", "service"].includes(config.authMode)) {
    fail(`Unsupported LOAD_TEST_AUTH_MODE=${config.authMode}. Expected anon, authenticated, or service.`);
  }

  if (config.authMode === "service" && !config.supabaseServiceRoleKey) {
    fail("LOAD_TEST_AUTH_MODE=service requires LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY. Use only in dedicated staging.");
  }

  if ((config.adminScenario || config.authMode === "authenticated") && !config.supabaseAccessToken && config.authMode !== "service") {
    fail("This scenario/auth mode requires LOAD_TEST_SUPABASE_ACCESS_TOKEN. Do not use production tokens unless an approved production test window exists.");
  }

  if (config.adminPublicationEnabled && (!config.supabaseAccessToken || !config.adminUserId)) {
    fail("LOAD_TEST_ADMIN_PUBLICATION_ENABLED=true requires LOAD_TEST_SUPABASE_ACCESS_TOKEN and LOAD_TEST_ADMIN_USER_ID for a staging event owner.");
  }

  if (config.includeRealtime) {
    fail("LOAD_TEST_REALTIME_ENABLED is reserved for a future Supabase Realtime protocol scenario. Current suite models the app's cutoff-aware cursor-delta HTTP path.");
  }

  if (!["staging", "load-test"].includes(config.environment.toLowerCase())) {
    fail("LOAD_TEST_ENVIRONMENT must equal staging or load-test.");
  }

  const targetHost = safeHost(config.targetUrl || config.baseUrl);
  if (!targetHost || targetHost !== config.allowedHost) {
    fail(`Target host ${targetHost || "invalid"} must match LOAD_TEST_ALLOWED_HOST=${config.allowedHost}.`);
  }

  if (/prod/i.test(config.environment) || targetHost.includes("websiteformusicians.com")) {
    fail("Production-like load-test target refused.");
  }

  if (config.writeScenario && !config.writeEnabled) {
    fail("This scenario writes chat data. Set LOAD_TEST_WRITE_ENABLED=true after choosing a safe staging/preview/local environment.");
  }

  if ((config.largeScenario || config.writeScenario || config.adminScenario) && config.confirmed !== CONFIRMATION) {
    fail(`Set LOAD_TEST_CONFIRMED=${CONFIRMATION} to run this scenario.`);
  }

  if ((config.largeScenario || config.maxVus >= 100) && !config.participantGenerationEnabled) {
    fail("Set LOAD_TEST_PARTICIPANT_GENERATION_ENABLED=true only for a dedicated staging/load-test fixture event.");
  }

  if (config.maxVus >= 5000 && (config.confirmHighLoad.toLowerCase() !== HIGH_LOAD_CONFIRMATION || !config.lowerStagesPassed)) {
    fail("5,000+ VU stages require LOAD_TEST_CONFIRM_HIGH_LOAD=true and LOAD_TEST_LOWER_STAGES_PASSED=true.");
  }

  if (isProductionEnvironment(config) && (config.productionOverride !== PRODUCTION_CONFIRMATION || !config.allowProduction)) {
    fail(`Production-like target refused. Use staging/preview/local by default. If this is an approved production window, set LOAD_TEST_PRODUCTION_OVERRIDE=${PRODUCTION_CONFIRMATION} and use a scenario that explicitly allows production.`);
  }

  if (config.largeScenario && config.maxVus >= 10000 && config.environment.toLowerCase() === "local") {
    fail("10,000 VUs against local is refused by default. Use a dedicated preview/staging target and confirmation variables.");
  }
}

export function printConfig(config, extra = {}) {
  console.log(JSON.stringify({
    kind: "load-test-configuration",
    scenario: config.scenarioName,
    environment: config.environment,
    baseUrl: config.baseUrl,
    targetHost: safeHost(config.targetUrl || config.baseUrl),
    supabaseUrlHost: safeHost(config.supabaseUrl),
    eventId: config.eventId,
    runId: config.runId,
    maxVus: config.maxVus,
    stage: config.stage,
    scenarioKind: config.scenarioKind,
    duration: config.duration,
    writeEnabled: config.writeEnabled,
    includePageLoad: config.includePageLoad,
    includeAudioProbe: config.includeAudioProbe,
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    ...extra,
  }, null, 2));
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "invalid-url";
  }
}

export function commonThresholds() {
  return {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    heartbeat_failed: ["rate<0.005"],
    submission_unexpected_failed: ["rate<0.01"],
    heartbeat_duration: ["p(95)<1000", "p(99)<2500"],
    submission_duration: ["p(95)<1500"],
    session_init_duration: ["p(95)<1500"],
    visibility_leak: ["count==0"],
    pre_join_visibility_violation: ["count==0"],
    stale_scope_incident: ["count==0"],
    duplicate_public_delivery: ["count==0"],
  };
}

export function scenarioOptions(name, config, stages) {
  return {
    scenarios: {
      [name]: {
        executor: "ramping-vus",
        gracefulRampDown: "30s",
        stages,
      },
    },
    thresholds: commonThresholds(),
    summaryTrendStats: ["min", "avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  };
}

export function constantOptions(name, config, vus, duration) {
  return {
    scenarios: {
      [name]: {
        executor: "constant-vus",
        vus,
        duration,
        gracefulStop: "30s",
      },
    },
    thresholds: commonThresholds(),
    summaryTrendStats: ["min", "avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  };
}
