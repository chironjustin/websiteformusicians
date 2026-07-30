import { check, sleep } from "k6";
import exec from "k6/execution";
import { getEvent, joinChat, loadPublicPage, probeAudio, detectDuplicatePublicDelivery, fetchVisibleMessages, submitMessage, verifyNoQueuedLeak, verifySenderPrivateVisible } from "./supabase.js";
import { jitter, messageBody, pickProfile, shouldSubmitForProfile, uuidv4, weightedDelayInWindow } from "./random.js";
import { duplicatePublicDelivery } from "./metrics.js";

const listenerState = {};

export function setupScenario(config) {
  printRunHeader(config);
  const event = getEvent(config);
  check(event || {}, {
    "target event exists": value => Boolean(value?.id),
    "target event matches configured id": value => value?.id === config.eventId,
  });
  return {
    runId: config.runId,
    event,
  };
}

export function listenerIteration(config, data, behavior = "mixed") {
  const state = getOrInitListener(config, data);
  const messages = fetchVisibleMessages(config, state.identity, state);
  if (detectDuplicatePublicDelivery(messages, state.seenPublicMessages)) {
    duplicatePublicDelivery.add(1);
  }

  if (config.includeAudioProbe && state.iteration === 0) {
    probeAudio(config, data.event);
  }

  if (behavior === "passive" || !config.writeEnabled) {
    state.iteration += 1;
    sleep(jitter(config.heartbeatIntervalSeconds * 0.75, config.heartbeatIntervalSeconds * 1.25));
    return;
  }

  const elapsed = exec.scenario.progress * durationSeconds(config.duration);
  if (behavior === "peak") {
    maybePeakSubmit(config, state, elapsed);
  } else if (shouldSubmitForProfile(state.profile, state.iteration, elapsed)) {
    submitLegalMessage(config, state);
  }

  state.iteration += 1;
  sleep(jitter(config.heartbeatIntervalSeconds * 0.75, config.heartbeatIntervalSeconds * 1.25));
}

export function rateLimitIteration(config, data) {
  const state = getOrInitListener(config, data);
  if (state.rateLimitDone) {
    sleep(5);
    return;
  }

  const accepted = [];
  for (let i = 0; i < 3; i += 1) {
    const result = submitMessage(config, state.identity, messageBody(config.runId, __VU, i, "rate limit legal"));
    check(result, { "first three submissions accepted": value => value.accepted === true });
    if (result.accepted) accepted.push(result.message);
    sleep(0.5);
  }

  const fourth = submitMessage(config, state.identity, messageBody(config.runId, __VU, 4, "rate limit expected"), true);
  check(fourth, { "fourth submission is server rate limited": value => value.rateLimited === true });

  if (accepted[0]) verifySenderPrivateVisible(config, state.identity, accepted[0]);
  state.rateLimitDone = true;
  sleep(120);

  const next = submitMessage(config, state.identity, messageBody(config.runId, __VU, 5, "rate limit reopen"));
  check(next, { "submission succeeds after rolling window": value => value.accepted === true });
}

export function queueIteration(config, data) {
  const state = getOrInitListener(config, data);
  if (config.writeEnabled && state.iteration < 3) {
    submitLegalMessage(config, state);
  }
  fetchVisibleMessages(config, state.identity, state, { endpoint: "queue_observe" });
  state.iteration += 1;
  sleep(jitter(config.heartbeatIntervalSeconds * 0.75, config.heartbeatIntervalSeconds * 1.25));
}

function getOrInitListener(config, data) {
  const key = String(__VU);
  if (listenerState[key]) return listenerState[key];

  loadPublicPage(config);
  const sessionId = uuidv4();
  const identity = joinChat(config, sessionId);
  const profile = pickProfile(config, __VU);
  const state = {
    identity,
    profile,
    iteration: 0,
    seenPublicMessages: {},
    publicCursor: null,
    publicUpdateCursor: null,
    privateCursor: null,
    peakSubmissionsSent: 0,
    rateLimitDone: false,
  };
  listenerState[key] = state;
  return state;
}

function submitLegalMessage(config, state) {
  const result = submitMessage(config, state.identity, messageBody(config.runId, __VU, state.iteration));
  if (result.accepted) {
    verifySenderPrivateVisible(config, state.identity, result.message);
  }
  return result;
}

function maybePeakSubmit(config, state, elapsedSeconds) {
  const start = config.peakStartsAfterSeconds;
  const end = start + config.peakWindowSeconds;
  if (elapsedSeconds < start || elapsedSeconds > end) return;

  const unit = ((__VU * 9301 + 49297) % 233280) / 233280;
  const maxMessages = unit < config.peakThirdSubmitPct
    ? 3
    : unit < config.peakThirdSubmitPct + config.peakSecondSubmitPct
      ? 2
      : unit < config.peakThirdSubmitPct + config.peakSecondSubmitPct + config.peakFirstSubmitPct
        ? 1
        : 0;

  if (state.peakSubmissionsSent >= maxMessages) return;
  const idealOffset = weightedDelayInWindow(config.peakWindowSeconds);
  if (elapsedSeconds - start >= idealOffset) {
    const result = submitLegalMessage(config, state);
    if (result.accepted) state.peakSubmissionsSent += 1;
  }
}

function durationSeconds(duration) {
  const match = String(duration).match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (match[2] === "h") return value * 3600;
  if (match[2] === "m") return value * 60;
  return value;
}

function printRunHeader(config) {
  console.log(JSON.stringify({
    scenario: config.scenarioName,
    runId: config.runId,
    environment: config.environment,
    targetUrl: config.baseUrl,
    eventId: config.eventId,
    maxVus: config.maxVus,
    duration: config.duration,
    writeEnabled: config.writeEnabled,
    audioProbeEnabled: config.includeAudioProbe,
    expectedRequestPattern: "page load once per VU, join RPC once per VU, cutoff-aware message fetch approximately every heartbeat interval, optional legal chat submissions by profile",
  }, null, 2));
}
