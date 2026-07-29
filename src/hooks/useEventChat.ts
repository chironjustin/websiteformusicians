import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getAdminChatMessages, getPublicChatMessageDelta } from "@/services/chatService";
import type { ChatMessage, VisitorChatMessageDelta, VisitorPrivateCursor, VisitorPublicCursor, VisitorPublicUpdateCursor } from "@/types/chat";
import type { MutableRefObject } from "react";

type ChatMode = "admin" | "public";
type PublicChatViewer = { participantId: string; sessionId: string; joinedAt: string } | null;
const DELTA_PAGE_LIMIT = 200;
const PUBLIC_SAFETY_POLL_MS = 10_000;
const DELTA_DEBOUNCE_MS = 180;
const DELTA_JITTER_MS = 420;

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
  const viewerKey = viewer ? `${viewer.participantId}:${viewer.sessionId}:${viewer.joinedAt}` : "";

  const loadMessages = useCallback(async (showLoading = true) => {
    const scope = `${mode}:${eventId ?? ""}:${viewerKey}`;
    const generation = scopeGenerationRef.current;
    let ownsDeltaFetch = false;

    if (activeScopeRef.current !== scope) return;

    if (!eventId || (mode === "public" && !viewer)) {
      setMessages([]);
      setLoading(false);
      return;
    }

    try {
      if (showLoading) setLoading(true);
      if (mode === "admin") {
        const nextMessages = await getAdminChatMessages(eventId);
        if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
        setMessages(nextMessages);
      } else {
        if (fetchingDeltaRef.current) {
          pendingDeltaRef.current = true;
          return;
        }

        fetchingDeltaRef.current = true;
        ownsDeltaFetch = true;
        let shouldContinue = true;

        while (shouldContinue) {
          const deltaMessages = await getPublicChatMessageDelta(eventId, viewer, {
            publicCursor: publicCursorRef.current,
            publicUpdateCursor: publicUpdateCursorRef.current,
            privateCursor: privateCursorRef.current,
            limit: DELTA_PAGE_LIMIT,
          });

          if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
          const activePinIds = new Set(
            deltaMessages
              .filter(message => message.visibility_scope === "active_pin" && message.is_pinned)
              .map(message => message.id),
          );
          const advancedStreams = advanceDeltaCursors(deltaMessages, viewer, publicCursorRef, publicUpdateCursorRef, privateCursorRef);
          setMessages(current => mergeDeltaMessages(applyActivePinSnapshot(current, activePinIds), deltaMessages, viewer.participantId));

          shouldContinue = (
            (advancedStreams.publicNew && countDeltaScope(deltaMessages, "public_new") >= DELTA_PAGE_LIMIT)
            || (advancedStreams.publicUpdate && countDeltaScope(deltaMessages, "public_update") >= DELTA_PAGE_LIMIT)
            || (advancedStreams.private && countDeltaScope(deltaMessages, "own") >= DELTA_PAGE_LIMIT)
          );
        }
      }
      setError(null);
    } catch (err) {
      if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
      setError(err instanceof Error ? err.message : "Unable to load chat.");
    } finally {
      if (ownsDeltaFetch) fetchingDeltaRef.current = false;
      if (activeScopeRef.current !== scope || scopeGenerationRef.current !== generation) return;
      setLoading(false);
      if (ownsDeltaFetch && pendingDeltaRef.current) {
        pendingDeltaRef.current = false;
        const jitter = DELTA_DEBOUNCE_MS + Math.floor(Math.random() * DELTA_JITTER_MS);
        window.setTimeout(() => void loadMessages(false), jitter);
      }
    }
  }, [eventId, mode, viewer, viewerKey]);

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
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
  }, [eventId, mode, viewer, viewerKey]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const scheduleDeltaFetch = useCallback(() => {
    if (mode === "admin") {
      void loadMessages(false);
      return;
    }

    if (!eventId || !viewer) return;
    if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
    const jitter = DELTA_DEBOUNCE_MS + Math.floor(Math.random() * DELTA_JITTER_MS);
    deltaTimerRef.current = window.setTimeout(() => {
      deltaTimerRef.current = null;
      void loadMessages(false);
    }, jitter);
  }, [eventId, loadMessages, mode, viewer]);

  useEffect(() => {
    if (!eventId) return;
    if (mode === "public" && !viewer) return;

    const channel = supabase
      .channel(`chat-messages-${mode}-${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_messages", filter: `event_id=eq.${eventId}` },
        () => {
          scheduleDeltaFetch();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, mode, scheduleDeltaFetch, viewer]);

  useEffect(() => {
    if (mode !== "public" || !eventId || !viewer) return;
    const id = window.setInterval(() => {
      scheduleDeltaFetch();
    }, PUBLIC_SAFETY_POLL_MS);
    return () => window.clearInterval(id);
  }, [eventId, mode, scheduleDeltaFetch, viewer]);

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
