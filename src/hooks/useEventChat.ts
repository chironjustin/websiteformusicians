import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getAdminChatMessages, getPublicChatMessages } from "@/services/chatService";
import type { ChatMessage } from "@/types/chat";

type ChatMode = "admin" | "public";

export function useEventChat(eventId: string | null | undefined, mode: ChatMode) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(eventId));
  const [error, setError] = useState<string | null>(null);
  const activeScopeRef = useRef("");

  const loadMessages = useCallback(async () => {
    const scope = `${mode}:${eventId ?? ""}`;
    activeScopeRef.current = scope;

    if (!eventId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const nextMessages = mode === "admin"
        ? await getAdminChatMessages(eventId)
        : await getPublicChatMessages(eventId);
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
  }, [eventId, mode]);

  useEffect(() => {
    activeScopeRef.current = `${mode}:${eventId ?? ""}`;
    setMessages([]);
    setError(null);
    setLoading(Boolean(eventId));
  }, [eventId, mode]);

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
          loadMessages();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, loadMessages, mode]);

  const grouped = useMemo(() => ({
    pending: messages.filter(message => message.status === "pending"),
    approved: messages.filter(message => message.status === "approved"),
    rejected: messages.filter(message => message.status === "rejected"),
  }), [messages]);

  return { messages, grouped, loading, error, refetch: loadMessages };
}
