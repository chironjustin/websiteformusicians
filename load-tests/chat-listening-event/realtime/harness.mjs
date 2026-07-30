import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createClient } from "@supabase/supabase-js";
import { advanceCursors, assertNoPreJoinMessages, mergeById } from "../helpers/cursors.mjs";
import { estimateWorkload, parseArgs, readJson, validateStageRequest } from "../helpers/load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (isMainThread) {
  const args = parseArgs();
  const stages = readJson(resolve(root, "config/stages.json"));
  const scenarios = readJson(resolve(root, "config/scenarios.json"));
  const context = validateStageRequest({ args, stages, scenarios });
  const workers = Math.max(1, Number.parseInt(process.env.LOAD_TEST_REALTIME_WORKERS || "4", 10));
  const clientsPerWorker = Math.ceil(context.stage.concurrency / workers);
  const expected = estimateWorkload(context);
  const startedAt = Date.now();
  const summaries = [];

  console.log(JSON.stringify({
    kind: "realtime-harness-start",
    runId: context.runId,
    stage: context.stageKey,
    scenario: context.scenario,
    workers,
    clients: context.stage.concurrency,
    expected,
  }, null, 2));

  for (let index = 0; index < workers; index += 1) {
    const start = index * clientsPerWorker;
    const count = Math.max(0, Math.min(clientsPerWorker, context.stage.concurrency - start));
    if (count <= 0) continue;
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: {
        index,
        start,
        count,
        context,
        durationMs: expected.seconds * 1000,
      },
    });
    worker.on("message", message => {
      if (message.type === "summary") summaries.push(message.summary);
      if (message.type === "log") console.log(JSON.stringify(message.payload));
    });
    worker.on("error", error => {
      console.error(`Realtime worker ${index} failed:`, error);
      process.exitCode = 1;
    });
  }

  const waitMs = expected.seconds * 1000 + 30_000;
  setTimeout(() => {
    const total = summarize(summaries, context, startedAt);
    const reportsDir = resolve(root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(resolve(reportsDir, `${context.runId}-${context.stageKey}-${context.scenario}-realtime.json`), JSON.stringify(total, null, 2));
    writeFileSync(resolve(reportsDir, `${context.runId}-${context.stageKey}-${context.scenario}-realtime.md`), markdown(total));
    console.log(JSON.stringify({ kind: "realtime-harness-summary", ...total }, null, 2));
    process.exit(process.exitCode ?? 0);
  }, waitMs);
} else {
  runWorker(workerData).catch(error => {
    parentPort.postMessage({ type: "log", payload: { kind: "realtime-worker-error", worker: workerData.index, message: error.message } });
    process.exit(1);
  });
}

async function runWorker(data) {
  const clients = [];
  const stopAt = Date.now() + data.durationMs;
  const intervalMs = Number(process.env.LOAD_TEST_HEARTBEAT_INTERVAL_SECONDS || "3") * 1000;

  for (let offset = 0; offset < data.count; offset += 1) {
    const vu = data.start + offset + 1;
    clients.push(await createRealtimeClient(data.context, vu));
    if (offset % 25 === 0) await sleep(10);
  }

  while (Date.now() < stopAt) {
    await Promise.all(clients.map(client => client.tick()));
    await sleep(intervalMs);

    if (data.context.scenario === "reconnect" && Math.random() < 0.02) {
      const candidate = clients[Math.floor(Math.random() * clients.length)];
      if (candidate) await candidate.reconnect("jittered-reconnect");
    }
    if (data.context.scenario === "foreground" && Math.random() < 0.05) {
      const candidate = clients[Math.floor(Math.random() * clients.length)];
      if (candidate) await candidate.recover("foreground");
    }
    if (data.context.scenario === "scope-switch" && Math.random() < 0.01) {
      const candidate = clients[Math.floor(Math.random() * clients.length)];
      if (candidate) await candidate.close("scope-switch");
    }
  }

  await Promise.all(clients.map(client => client.close("end")));
  parentPort.postMessage({ type: "summary", summary: summarizeClients(data.index, clients) });
}

async function createRealtimeClient(context, vu) {
  const supabase = createClient(context.supabaseUrl, process.env.LOAD_TEST_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  const sessionId = randomUuid();
  const state = {
    vu,
    messages: [],
    publicCursor: null,
    publicUpdateCursor: null,
    privateCursor: null,
    joinedAt: null,
    participantId: null,
    subscribed: false,
    status: "connecting",
    channel: null,
    metrics: {
      joinOk: 0,
      joinFailed: 0,
      subscribed: 0,
      channelErrors: 0,
      realtimeWakeups: 0,
      deltaFetches: 0,
      pollFetches: 0,
      foregroundRecoveries: 0,
      reconnects: 0,
      rows: 0,
      zeroRows: 0,
      visibilityLeaks: 0,
      duplicates: 0,
      staleScopeRejected: 0,
    },
  };

  const joinResult = await supabase.rpc("join_event_chat", {
    p_event_id: context.eventId,
    p_session_id: sessionId,
  });
  if (joinResult.error) {
    state.metrics.joinFailed += 1;
    throw new Error(`join_event_chat failed for vu ${vu}: ${joinResult.error.message}`);
  }
  const participant = Array.isArray(joinResult.data) ? joinResult.data[0] : joinResult.data;
  state.participantId = participant.id;
  state.joinedAt = participant.joined_at;
  state.metrics.joinOk += 1;

  async function fetchDelta(reason) {
    const { data, error } = await supabase.rpc("get_visitor_visible_chat_message_delta", {
      p_event_id: context.eventId,
      p_participant_id: state.participantId,
      p_session_id: sessionId,
      p_after_published_at: state.publicCursor?.publishedAt ?? null,
      p_after_id: state.publicCursor?.id ?? null,
      p_after_public_updated_at: state.publicUpdateCursor?.updatedAt ?? null,
      p_after_public_updated_id: state.publicUpdateCursor?.id ?? null,
      p_after_private_updated_at: state.privateCursor?.updatedAt ?? null,
      p_after_private_id: state.privateCursor?.id ?? null,
      p_limit: Number(process.env.LOAD_TEST_MESSAGE_PAGE_LIMIT || "200"),
    });
    if (error) throw new Error(`delta failed for vu ${vu}: ${error.message}`);
    const rows = Array.isArray(data) ? data : [];
    state.metrics.deltaFetches += 1;
    if (reason === "poll") state.metrics.pollFetches += 1;
    if (reason === "foreground") state.metrics.foregroundRecoveries += 1;
    if (rows.length === 0) state.metrics.zeroRows += 1;
    state.metrics.rows += rows.length;
    if (!assertNoPreJoinMessages(rows, state.joinedAt)) state.metrics.visibilityLeaks += 1;
    const before = new Set(state.messages.map(message => message.id));
    state.messages = mergeById(state.messages, rows);
    for (const row of rows) {
      if (row.visibility_scope === "public_new" && before.has(row.id)) state.metrics.duplicates += 1;
    }
    advanceCursors(state, rows, state.participantId, state.joinedAt);
  }

  async function subscribe() {
    state.channel = supabase
      .channel(`loadtest-chat-${context.runId}-${vu}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_messages", filter: `event_id=eq.${context.eventId}` },
        () => {
          state.metrics.realtimeWakeups += 1;
          void fetchDelta("realtime").catch(error => {
            parentPort.postMessage({ type: "log", payload: { kind: "delta-error", vu, reason: "realtime", message: error.message } });
          });
        },
      )
      .subscribe(status => {
        state.status = status;
        if (status === "SUBSCRIBED") {
          state.subscribed = true;
          state.metrics.subscribed += 1;
          void fetchDelta("subscribed");
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          state.metrics.channelErrors += 1;
        }
      });
  }

  await subscribe();

  return {
    get metrics() {
      return state.metrics;
    },
    async tick() {
      await fetchDelta("poll");
    },
    async recover(reason) {
      await sleep(Number(process.env.LOAD_TEST_RECOVERY_JITTER_MS || "1000") * Math.random());
      await fetchDelta(reason);
    },
    async reconnect(reason) {
      state.metrics.reconnects += 1;
      if (state.channel) await supabase.removeChannel(state.channel);
      await sleep(100 + Math.random() * 2000);
      await subscribe();
      await fetchDelta(reason);
    },
    async close(reason) {
      if (state.channel) await supabase.removeChannel(state.channel);
      state.status = `closed:${reason}`;
    },
  };
}

function summarizeClients(worker, clients) {
  const totals = {
    worker,
    attemptedClients: clients.length,
    joinOk: 0,
    joinFailed: 0,
    subscribed: 0,
    channelErrors: 0,
    realtimeWakeups: 0,
    deltaFetches: 0,
    pollFetches: 0,
    foregroundRecoveries: 0,
    reconnects: 0,
    rows: 0,
    zeroRows: 0,
    visibilityLeaks: 0,
    duplicates: 0,
    staleScopeRejected: 0,
  };
  for (const client of clients) {
    for (const key of Object.keys(totals)) {
      if (key === "worker" || key === "attemptedClients") continue;
      totals[key] += client.metrics[key] || 0;
    }
  }
  return totals;
}

function summarize(workerSummaries, context, startedAt) {
  const total = {
    runId: context.runId,
    stage: context.stageKey,
    scenario: context.scenario,
    environment: context.environment,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    attemptedClients: 0,
    joinOk: 0,
    joinFailed: 0,
    subscribed: 0,
    channelErrors: 0,
    realtimeWakeups: 0,
    deltaFetches: 0,
    pollFetches: 0,
    foregroundRecoveries: 0,
    reconnects: 0,
    rows: 0,
    zeroRows: 0,
    visibilityLeaks: 0,
    duplicates: 0,
    staleScopeRejected: 0,
  };
  for (const summary of workerSummaries) {
    for (const key of Object.keys(total)) {
      if (typeof total[key] === "number") total[key] += summary[key] || 0;
    }
  }
  total.deltaRpcCallsPerRealtimeWakeup = total.realtimeWakeups > 0 ? total.deltaFetches / total.realtimeWakeups : null;
  return total;
}

function markdown(summary) {
  return [
    `# Realtime load-test summary: ${summary.runId}`,
    "",
    `Stage: ${summary.stage}`,
    `Scenario: ${summary.scenario}`,
    `Attempted clients: ${summary.attemptedClients}`,
    `Subscribed: ${summary.subscribed}`,
    `Realtime wakeups: ${summary.realtimeWakeups}`,
    `Delta fetches: ${summary.deltaFetches}`,
    `Poll fetches: ${summary.pollFetches}`,
    `Visibility leaks: ${summary.visibilityLeaks}`,
    `Duplicate public deliveries: ${summary.duplicates}`,
    `Delta RPC calls per Realtime wakeup: ${summary.deltaRpcCallsPerRealtimeWakeup ?? "n/a"}`,
    "",
    "Attach Supabase Realtime and database dashboard screenshots before approving the next stage.",
    "",
  ].join("\n");
}

function randomUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

