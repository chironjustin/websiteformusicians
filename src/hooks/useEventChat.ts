import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getAdminChatMessages, getPublicChatMessages } from "@/services/chatService";
import type { ChatMessage } from "@/types/chat";

type ChatMode = "admin" | "public";
type PublicChatViewer = { participantId: string; sessionId: string } | null;

export function useEventChat(eventId: string | null | undefined, mode: ChatMode, viewer: PublicChatViewer = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(eventId));
  const [error, setError] = useState<string | null>(null);
  const activeScopeRef = useRef("");
  const viewerKey = viewer ? `${viewer.participantId}:${viewer.sessionId}` : "";

  const loadMessages = useCallback(async (showLoading = true) => {
    const scope = `${mode}:${eventId ?? ""}:${viewerKey}`;
    activeScopeRef.current = scope;

    if (!eventId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    try {
      if (showLoading) setLoading(true);
      const nextMessages = mode === "admin"
        ? await getAdminChatMessages(eventId)
        : await getPublicChatMessages(eventId, viewer);
      if (activeScopeRef.current !== scope) return;
      setMessages(nextMessages);
      setError(null);
    } catch (err) {
      if (activeScopeRef.current !== scope) return;
      setError(err instanceof Error ? err.message : "Unable to load chat.");
    } finally {
      if (activeScopeRef.current !== scope) return;
      setLoading(false);
    }
  }, [eventId, mode, viewer, viewerKey]);

  useEffect(() => {
    activeScopeRef.current = `${mode}:${eventId ?? ""}:${viewerKey}`;
    setMessages([]);
    setError(null);
    setLoading(Boolean(eventId));
  }, [eventId, mode, viewerKey]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!eventId) return;

    const channel = supabase
      .channel(`chat-messages-${mode}-${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_messages", filter: `event_id=eq.${eventId}` },
        () => {
          loadMessages(false);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, loadMessages, mode]);

  useEffect(() => {
    if (mode !== "public" || !eventId || !viewer) return;
    const id = window.setInterval(() => {
      loadMessages(false);
    }, 3000);
    return () => window.clearInterval(id);
  }, [eventId, loadMessages, mode, viewer]);

  const grouped = useMemo(() => ({
    pending: messages.filter(message => message.status === "pending"),
    queued: messages.filter(message => message.status === "queued"),
    approved: messages.filter(message => message.status === "approved"),
    rejected: messages.filter(message => message.status === "rejected"),
  }), [messages]);

  return { messages, grouped, loading, error, refetch: loadMessages };
}
