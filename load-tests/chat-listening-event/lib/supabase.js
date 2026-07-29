import http from "k6/http";
import { check, fail } from "k6";
import {
  acceptedSubmissions,
  audioProbeDuration,
  heartbeatDuration,
  heartbeatFailed,
  intentionalRateLimits,
  listenerCountDuration,
  pageLoadDuration,
  publicFetchDuration,
  queuedPrivateVisible,
  sessionInitDuration,
  submissionDuration,
  submissionUnexpectedFailed,
  unexpectedSubmissionRejections,
  visibilityLeak,
} from "./metrics.js";
import { uuidv4 } from "./random.js";

export function supabaseHeaders(config, extra = {}) {
  const apiKey = config.authMode === "service" && config.supabaseServiceRoleKey ? config.supabaseServiceRoleKey : config.supabaseAnonKey;
  const bearer = config.authMode === "service" && config.supabaseServiceRoleKey
    ? config.supabaseServiceRoleKey
    : config.supabaseAccessToken || config.supabaseAnonKey;
  return {
    "Content-Type": "application/json",
    "apikey": apiKey,
    "Authorization": `Bearer ${bearer}`,
    ...extra,
  };
}

export function rpc(config, name, body, tags = {}) {
  return http.post(
    `${config.supabaseUrl}/rest/v1/rpc/${name}`,
    JSON.stringify(body),
    {
      headers: supabaseHeaders(config),
      tags: { rpc: name, ...tags },
      timeout: "30s",
    },
  );
}

export function getEvent(config) {
  const res = http.get(
    `${config.supabaseUrl}/rest/v1/events?select=*&id=eq.${encodeURIComponent(config.eventId)}&limit=1`,
    { headers: supabaseHeaders(config), tags: { endpoint: "event" }, timeout: "30s" },
  );
  check(res, { "event fetch ok": r => r.status === 200 });
  const rows = safeJson(res, []);
  return Array.isArray(rows) ? rows[0] : null;
}

export function loadPublicPage(config) {
  if (!config.includePageLoad) return null;
  const started = Date.now();
  const res = http.get(config.baseUrl, { tags: { endpoint: "public_page" }, timeout: "30s" });
  pageLoadDuration.add(Date.now() - started);
  check(res, { "public page ok": r => r.status >= 200 && r.status < 400 });
  return res;
}

export function joinChat(config, sessionId) {
  const started = Date.now();
  const res = rpc(config, "join_event_chat", {
    p_event_id: config.eventId,
    p_session_id: sessionId,
  });
  sessionInitDuration.add(Date.now() - started);
  check(res, { "join_event_chat ok": r => r.status === 200 });
  if (res.status !== 200) fail(`join_event_chat failed: ${safeText(res)}`);
  const data = safeJson(res, null);
  const participant = Array.isArray(data) ? data[0] : data;
  if (!participant || !participant.id || !participant.session_id || !participant.display_name || !participant.joined_at) {
    fail(`Invalid join_event_chat response shape: ${safeText(res)}`);
  }
  return {
    participantId: participant.id,
    sessionId: participant.session_id,
    displayName: participant.display_name,
    joinedAt: participant.joined_at,
  };
}

export function fetchVisibleMessages(config, identity, state = {}, tags = {}) {
  const started = Date.now();
  const res = rpc(config, "get_visitor_visible_chat_message_delta", {
    p_event_id: config.eventId,
    p_participant_id: identity.participantId,
    p_session_id: identity.sessionId,
    p_after_published_at: state.publicCursor?.publishedAt || null,
    p_after_id: state.publicCursor?.id || null,
    p_after_public_updated_at: state.publicUpdateCursor?.updatedAt || null,
    p_after_public_updated_id: state.publicUpdateCursor?.id || null,
    p_after_private_updated_at: state.privateCursor?.updatedAt || null,
    p_after_private_id: state.privateCursor?.id || null,
    p_limit: config.messagePageLimit || 200,
  }, { endpoint: "visible_message_delta", ...tags });
  const elapsed = Date.now() - started;
  publicFetchDuration.add(elapsed);
  heartbeatDuration.add(elapsed);
  const ok = res.status === 200;
  heartbeatFailed.add(!ok);
  check(res, { "visible message delta fetch ok": () => ok });
  if (!ok) return [];
  const messages = safeJson(res, []);
  if (!Array.isArray(messages)) return [];
  advanceVisibleMessageCursors(messages, identity, state);
  return messages;
}

export function getListenerCount(config) {
  const started = Date.now();
  const res = rpc(config, "get_event_listener_count", { p_event_id: config.eventId }, { endpoint: "listener_count" });
  listenerCountDuration.add(Date.now() - started);
  check(res, { "listener count ok": r => r.status === 200 });
  const data = safeJson(res, {});
  return typeof data?.count === "number" ? data.count : 0;
}

export function submitMessage(config, identity, body, expectedRateLimit = false) {
  const started = Date.now();
  const res = rpc(config, "submit_chat_message", {
    p_event_id: config.eventId,
    p_participant_id: identity.participantId,
    p_session_id: identity.sessionId,
    p_body: body,
    p_client_token: uuidv4(),
  }, { endpoint: "submit" });
  submissionDuration.add(Date.now() - started);
  const data = safeJson(res, null);
  const accepted = res.status === 200 && data?.ok === true && data?.message?.id;
  const rateLimited = res.status === 200 && data?.ok === false && data?.code === config.expectedRateLimitCode;

  if (accepted) {
    acceptedSubmissions.add(1);
    return { accepted: true, message: data.message, response: data };
  }

  if (rateLimited && expectedRateLimit) {
    intentionalRateLimits.add(1);
    return { accepted: false, rateLimited: true, response: data };
  }

  submissionUnexpectedFailed.add(true);
  unexpectedSubmissionRejections.add(1);
  return { accepted: false, rateLimited, response: data, status: res.status, raw: safeText(res) };
}

export function verifySenderPrivateVisible(config, identity, submittedMessage) {
  if (!submittedMessage?.id) return false;
  const messages = fetchVisibleMessages(config, identity, {}, { verification: "sender_private" });
  const seen = messages.some(message => message.id === submittedMessage.id);
  queuedPrivateVisible.add(seen ? 1 : 0);
  check({ seen }, { "sender sees own submitted message": v => v.seen });
  return seen;
}

export function verifyNoQueuedLeak(config, otherIdentity, submittedMessage) {
  if (!submittedMessage?.id || submittedMessage.status === "approved") return true;
  const messages = fetchVisibleMessages(config, otherIdentity, {}, { verification: "queued_leak" });
  const leaked = messages.some(message => message.id === submittedMessage.id);
  if (leaked) visibilityLeak.add(1);
  check({ leaked }, { "other participant cannot see queued private message": v => !v.leaked });
  return !leaked;
}

export function probeAudio(config, event) {
  if (!config.includeAudioProbe || !event?.audio_path) return;
  const encodedPath = String(event.audio_path).split("/").map(encodeURIComponent).join("/");
  const started = Date.now();
  const res = http.post(
    `${config.supabaseUrl}/storage/v1/object/sign/audio/${encodedPath}`,
    JSON.stringify({ expiresIn: 60 }),
    { headers: supabaseHeaders(config), tags: { endpoint: "audio_signed_url_probe" }, timeout: "30s" },
  );
  audioProbeDuration.add(Date.now() - started);
  check(res, { "audio signed-url probe ok": r => r.status >= 200 && r.status < 500 });
}

export function detectDuplicatePublicDelivery(messages, seen) {
  let duplicate = false;
  for (const message of messages) {
    if (message.status !== "approved") continue;
    if (seen[message.id]) duplicate = true;
    seen[message.id] = true;
  }
  return duplicate;
}

function advanceVisibleMessageCursors(messages, identity, state) {
  for (const message of messages) {
    if (message.participant_id === identity.participantId && message.updated_at) {
      if (!state.privateCursor || compareTuple(message.updated_at, message.id, state.privateCursor.updatedAt, state.privateCursor.id) > 0) {
        state.privateCursor = { updatedAt: message.updated_at, id: message.id };
      }
    }

    if (message.visibility_scope === "public_update" && message.updated_at) {
      if (!state.publicUpdateCursor || compareTuple(message.updated_at, message.id, state.publicUpdateCursor.updatedAt, state.publicUpdateCursor.id) > 0) {
        state.publicUpdateCursor = { updatedAt: message.updated_at, id: message.id };
      }
    }

    if (message.visibility_scope !== "public_new") continue;
    if (message.status !== "approved" || !message.published_at || message.published_at < identity.joinedAt) continue;
    if (!state.publicCursor || compareTuple(message.published_at, message.id, state.publicCursor.publishedAt, state.publicCursor.id) > 0) {
      state.publicCursor = { publishedAt: message.published_at, id: message.id };
    }
  }
}

function compareTuple(leftTime, leftId, rightTime, rightId) {
  const leftMillis = Date.parse(leftTime);
  const rightMillis = Date.parse(rightTime);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) {
    if (leftMillis > rightMillis) return 1;
    if (leftMillis < rightMillis) return -1;
  } else {
    if (leftTime > rightTime) return 1;
    if (leftTime < rightTime) return -1;
  }
  if (leftId > rightId) return 1;
  if (leftId < rightId) return -1;
  return 0;
}

export function safeJson(res, fallback) {
  try {
    return res.json();
  } catch {
    return fallback;
  }
}

export function safeText(res) {
  return String(res?.body || "").slice(0, 400);
}
