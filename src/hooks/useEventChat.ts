import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getAdminChatMessages, getPublicChatMessageDelta } from "@/services/chatService";
import type { ChatMessage, VisitorChatMessageDelta, VisitorPrivateCursor, VisitorPublicCursor, VisitorPublicUpdateCursor } from "@/types/chat";
import type { MutableRefObject } from "react";

type ChatMode = "admin" | "public";
type PublicChatViewer = { participantId: string; sessionId: string; joinedAt: string } | null;
type ChatFetchReason = "initial" | "subscribed" | "realtime" | "poll" | "focus" | "visibilitychange" | "pageshow" | "online" | "pending" | "manual";
const DELTA_PAGE_LIMIT = 200;
const PUBLIC_SAFETY_POLL_MS = 10_000;
const DELTA_DEBOUNCE_MS = 180;
const DELTA_JITTER_MS = 420;
const FOREGROUND_RECOVERY_DEBOUNCE_MS = 100;
const REALTIME_RECONNECT_BASE_MS = 1_000;
const REALTIME_RECONNECT_MAX_MS = 12_000;

function chatDebug(label: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.info(`[chat-delivery] ${label}`, {
    at: performance.now(),
    visibility: document.visibilityState,
    online: navigator.onLine,
    ...details,
  });
}

function compareCursorTuple(leftTime: string, leftId: string, rightTime: string, rightId: string) {
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

function sortForViewer(messages: ChatMessage[], participantId: string | null | undefined) {
  return [...messages].sort((left, right) => {
    if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1;

    const leftTime = left.participant_id === participantId
      ? left.created_at
      : left.published_at ?? left.created_at;
    const rightTime = right.participant_id === participantId
      ? right.created_at
      : right.published_at ?? right.created_at;

    const byTime = leftTime.localeCompare(rightTime);
    if (byTime !== 0) return byTime;
    return left.id.localeCompare(right.id);
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[], participantId: string | null | undefined) {
  const byId = new Map<string, ChatMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return sortForViewer(Array.from(byId.values()), participantId);
}

function mergeDeltaMessages(current: ChatMessage[], incoming: VisitorChatMessageDelta[], participantId: string | null | undefined) {
  const knownIds = new Set(current.map(message => message.id));
  const materialized = incoming.filter(message => (
    message.visibility_scope !== "public_update"
    || knownIds.has(message.id)
    || message.participant_id === participantId
  ));

  return mergeMessages(current, materialized as ChatMessage[], participantId);
}

function applyActivePinSnapshot(current: ChatMessage[], activePinIds: Set<string>) {
  return current.map(message => {
    if (!message.is_pinned || activePinIds.has(message.id)) return message;
    return { ...message, is_pinned: false };
  });
}

export function useEventChat(eventId: string | null | undefined, mode: ChatMode, viewer: PublicChatViewer = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const canReadChat = Boolean(eventId) && (mode === "admin" || Boolean(viewer));
  const [loading, setLoading] = useState(canReadChat);
  const [error, setError] = useState<string | null>(null);
  const activeScopeRef = useRef("");
  const scopeGenerationRef = useRef(0);
  const publicCursorRef = useRef<VisitorPublicCursor>(null);
  const publicUpdateCursorRef = useRef<VisitorPublicUpdateCursor>(null);
  const privateCursorRef = useRef<VisitorPrivateCursor>(null);
  const fetchingDeltaRef = useRef(false);
  const pendingDeltaRef = useRef(false);
  const deltaTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const realtimeStatusRef = useRef("idle");
  const reconnectAttemptRef = useRef(0);
  const [channelRetryNonce, setChannelRetryNonce] = useState(0);
  const viewerKey = viewer ? `${viewer.participantId}:${viewer.sessionId}:${viewer.joinedAt}` : "";

  const loadMessages = useCallback(async (showLoading = true, reason: ChatFetchReason = showLoading ? "initial" : "manual") => {
    const scope = `${mode}:${eventId ?? ""}:${viewerKey}`;
    const generation = scopeGenerationRef.current;
    let ownsDeltaFetch = false;
    const startedAt = performance.now();

    if (activeScopeRef.current !== scope) {
      chatDebug("fetch_skipped_stale_scope", { mode, reason, realtimeStatus: realtimeStatusRef.current });
      return;
    }

    if (!eventId || (mode === "public" && !viewer)) {
      chatDebug("fetch_skipped_missing_scope", { mode, reason, hasEvent: Boolean(eventId), hasViewer: Boolean(viewer) });
      setMessages([]);
      setLoading(false);
      return;
    }

    try {
      if (showLoading) setLoading(true);
      if (mode === "admin") {
        chatDebug("admin_fetch_start", { reason, eventId });
        const nextMessages = await getAdminChatMessages(eventId);
        if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
        setMessages(nextMessages);
        chatDebug("admin_fetch_end", { reason, eventId, rows: nextMessages.length, durationMs: performance.now() - startedAt });
      } else {
        if (fetchingDeltaRef.current) {
          pendingDeltaRef.current = true;
          chatDebug("delta_fetch_skipped_in_flight", { reason, realtimeStatus: realtimeStatusRef.current });
          return;
        }

        fetchingDeltaRef.current = true;
        ownsDeltaFetch = true;
        let shouldContinue = true;
        let pageCount = 0;
        let totalRows = 0;

        chatDebug("delta_fetch_start", { reason, realtimeStatus: realtimeStatusRef.current });

        while (shouldContinue) {
          const pageStartedAt = performance.now();
          const deltaMessages = await getPublicChatMessageDelta(eventId, viewer, {
            publicCursor: publicCursorRef.current,
            publicUpdateCursor: publicUpdateCursorRef.current,
            privateCursor: privateCursorRef.current,
            limit: DELTA_PAGE_LIMIT,
          });

          if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
          pageCount += 1;
          totalRows += deltaMessages.length;
          chatDebug("delta_page_end", {
            reason,
            page: pageCount,
            rows: deltaMessages.length,
            publicNew: countDeltaScope(deltaMessages, "public_new"),
            publicUpdate: countDeltaScope(deltaMessages, "public_update"),
            own: countDeltaScope(deltaMessages, "own"),
            activePin: countDeltaScope(deltaMessages, "active_pin"),
            durationMs: performance.now() - pageStartedAt,
            realtimeStatus: realtimeStatusRef.current,
          });
          const activePinIds = new Set(
            deltaMessages
              .filter(message => message.visibility_scope === "active_pin" && message.is_pinned)
              .map(message => message.id),
          );
          const advancedStreams = advanceDeltaCursors(deltaMessages, viewer, publicCursorRef, publicUpdateCursorRef, privateCursorRef);
          setMessages(current => {
            const mergeStartedAt = performance.now();
            const nextMessages = mergeDeltaMessages(applyActivePinSnapshot(current, activePinIds), deltaMessages, viewer.participantId);
            chatDebug("delta_merge", {
              reason,
              incomingRows: deltaMessages.length,
              beforeRows: current.length,
              afterRows: nextMessages.length,
              durationMs: performance.now() - mergeStartedAt,
            });
            return nextMessages;
          });

          shouldContinue = (
            (advancedStreams.publicNew && countDeltaScope(deltaMessages, "public_new") >= DELTA_PAGE_LIMIT)
            || (advancedStreams.publicUpdate && countDeltaScope(deltaMessages, "public_update") >= DELTA_PAGE_LIMIT)
            || (advancedStreams.private && countDeltaScope(deltaMessages, "own") >= DELTA_PAGE_LIMIT)
          );
        }

        chatDebug("delta_fetch_end", {
          reason,
          pages: pageCount,
          rows: totalRows,
          durationMs: performance.now() - startedAt,
          realtimeStatus: realtimeStatusRef.current,
        });
      }
      setError(null);
    } catch (err) {
      if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
      chatDebug("fetch_error", { mode, reason, message: err instanceof Error ? err.message : String(err), durationMs: performance.now() - startedAt });
      setError(err instanceof Error ? err.message : "Unable to load chat.");
    } finally {
      if (ownsDeltaFetch) fetchingDeltaRef.current = false;
      if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
      setLoading(false);
      if (ownsDeltaFetch && pendingDeltaRef.current) {
        pendingDeltaRef.current = false;
        const jitter = DELTA_DEBOUNCE_MS + Math.floor(Math.random() * DELTA_JITTER_MS);
        chatDebug("delta_pending_scheduled", { reason: "pending", delayMs: jitter, realtimeStatus: realtimeStatusRef.current });
        window.setTimeout(() => void loadMessages(false, "pending"), jitter);
      }
    }
  }, [eventId, mode, viewer, viewerKey]);

  useEffect(() => {
    if (mode !== "public" || !eventId || !viewer) return;
    chatDebug("participant_scope_ready", {
      eventId,
      hasParticipant: Boolean(viewer.participantId),
      hasSession: Boolean(viewer.sessionId),
      joinedAt: viewer.joinedAt,
    });
  }, [eventId, mode, viewer, viewerKey]);

  useEffect(() => {
    chatDebug("visible_message_render", {
      mode,
      eventId: eventId ?? null,
      viewerReady: Boolean(viewer),
      rows: messages.length,
      realtimeStatus: realtimeStatusRef.current,
    });
  }, [eventId, messages.length, mode, viewer]);

  useEffect(() => {
    activeScopeRef.current = `${mode}:${eventId ?? ""}:${viewerKey}`;
    scopeGenerationRef.current += 1;
    setMessages([]);
    setError(null);
    setLoading(Boolean(eventId) && (mode === "admin" || Boolean(viewer)));
    publicCursorRef.current = null;
    publicUpdateCursorRef.current = null;
    privateCursorRef.current = null;
    pendingDeltaRef.current = false;
    fetchingDeltaRef.current = false;
    realtimeStatusRef.current = "idle";
    reconnectAttemptRef.current = 0;
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [eventId, mode, viewer, viewerKey]);

  useEffect(() => {
    if (mode === "public") return;
    loadMessages(true, "initial");
  }, [loadMessages, mode]);

  const scheduleRecovery = useCallback((reason: ChatFetchReason) => {
    if (mode === "admin") {
      void loadMessages(false, reason);
      return;
    }

    if (!eventId || !viewer) return;
    if (recoveryTimerRef.current !== null) {
      chatDebug("recovery_coalesced", { reason, realtimeStatus: realtimeStatusRef.current });
      return;
    }

    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      void loadMessages(false, reason);
    }, FOREGROUND_RECOVERY_DEBOUNCE_MS);
  }, [eventId, loadMessages, mode, viewer]);

  const scheduleDeltaFetch = useCallback((reason: ChatFetchReason = "realtime") => {
    if (mode === "admin") {
      void loadMessages(false, reason);
      return;
    }

    if (!eventId || !viewer) return;
    if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
    const jitter = DELTA_DEBOUNCE_MS + Math.floor(Math.random() * DELTA_JITTER_MS);
    chatDebug("delta_wakeup_scheduled", { reason, delayMs: jitter, realtimeStatus: realtimeStatusRef.current });
    deltaTimerRef.current = window.setTimeout(() => {
      deltaTimerRef.current = null;
      void loadMessages(false, reason);
    }, jitter);
  }, [eventId, loadMessages, mode, viewer]);

  useEffect(() => {
    if (!eventId) return;
    if (mode === "public" && !viewer) return;
    let closed = false;
    const generation = scopeGenerationRef.current;
    const channelName = `chat-messages-${mode}-${eventId}`;
    chatDebug("realtime_channel_create", { mode, eventId, channelName, retry: channelRetryNonce });

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_messages", filter: `event_id=eq.${eventId}` },
        () => {
          chatDebug("realtime_change", { mode, eventId, realtimeStatus: realtimeStatusRef.current });
          scheduleDeltaFetch("realtime");
        },
      )
      .subscribe(status => {
        realtimeStatusRef.current = status;
        chatDebug("realtime_status", { mode, eventId, status, retry: channelRetryNonce });
        if (closed || scopeGenerationRef.current !== generation) return;

        if (status === "SUBSCRIBED") {
          reconnectAttemptRef.current = 0;
          scheduleRecovery("subscribed");
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (document.visibilityState === "visible") scheduleRecovery("realtime");
          if (reconnectTimerRef.current !== null) return;
          const attempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = attempt;
          const delay = Math.min(REALTIME_RECONNECT_MAX_MS, REALTIME_RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 4));
          chatDebug("realtime_reconnect_scheduled", { mode, eventId, status, attempt, delayMs: delay });
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!closed && scopeGenerationRef.current === generation) setChannelRetryNonce(value => value + 1);
          }, delay);
        }
      });

    return () => {
      closed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      chatDebug("realtime_channel_cleanup", { mode, eventId, channelName });
      supabase.removeChannel(channel);
    };
  }, [channelRetryNonce, eventId, mode, scheduleDeltaFetch, scheduleRecovery, viewer]);

  useEffect(() => {
    if (mode !== "public" || !eventId || !viewer) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        chatDebug("poll_skipped_hidden", { eventId, realtimeStatus: realtimeStatusRef.current });
        return;
      }
      scheduleDeltaFetch("poll");
    }, PUBLIC_SAFETY_POLL_MS);
    return () => window.clearInterval(id);
  }, [eventId, mode, scheduleDeltaFetch, viewer]);

  useEffect(() => {
    if (mode !== "public" || !eventId || !viewer) return;

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRecovery("visibilitychange");
    };
    const onFocus = () => scheduleRecovery("focus");
    const onPageShow = () => scheduleRecovery("pageshow");
    const onOnline = () => scheduleRecovery("online");

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [eventId, mode, scheduleRecovery, viewer]);

  const grouped = useMemo(() => ({
    pending: messages.filter(message => message.status === "pending"),
    queued: messages.filter(message => message.status === "queued"),
    approved: messages.filter(message => message.status === "approved"),
    rejected: messages.filter(message => message.status === "rejected"),
  }), [messages]);

  return { messages, grouped, loading, error, refetch: loadMessages };
}

function advanceDeltaCursors(
  messages: VisitorChatMessageDelta[],
  viewer: NonNullable<PublicChatViewer>,
  publicCursorRef: MutableRefObject<VisitorPublicCursor>,
  publicUpdateCursorRef: MutableRefObject<VisitorPublicUpdateCursor>,
  privateCursorRef: MutableRefObject<VisitorPrivateCursor>,
) {
  const advanced = {
    publicNew: false,
    publicUpdate: false,
    private: false,
  };

  for (const message of messages) {
    if (message.visibility_scope === "own") {
      const privateCursor = privateCursorRef.current;
      if (!privateCursor || compareCursorTuple(message.updated_at, message.id, privateCursor.updatedAt, privateCursor.id) > 0) {
        privateCursorRef.current = { updatedAt: message.updated_at, id: message.id };
        advanced.private = true;
      }
    }

    if (message.visibility_scope === "public_update") {
      const publicUpdateCursor = publicUpdateCursorRef.current;
      if (!publicUpdateCursor || compareCursorTuple(message.updated_at, message.id, publicUpdateCursor.updatedAt, publicUpdateCursor.id) > 0) {
        publicUpdateCursorRef.current = { updatedAt: message.updated_at, id: message.id };
        advanced.publicUpdate = true;
      }
    }

    if (message.visibility_scope === "public_new") {
      if (message.status !== "approved" || !message.published_at) continue;
      if (message.published_at < viewer.joinedAt) continue;

      const publicCursor = publicCursorRef.current;
      if (!publicCursor || compareCursorTuple(message.published_at, message.id, publicCursor.publishedAt, publicCursor.id) > 0) {
        publicCursorRef.current = { publishedAt: message.published_at, id: message.id };
        advanced.publicNew = true;
      }
    }
  }

  return advanced;
}

function countDeltaScope(messages: VisitorChatMessageDelta[], scope: VisitorChatMessageDelta["visibility_scope"]) {
  return messages.filter(message => message.visibility_scope === scope).length;
}
