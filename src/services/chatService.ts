import { supabase } from "@/lib/supabase";
import type { ChatMessage, ChatMessageStatus, ChatParticipant, CreateAdminChatMessageInput, CreateVisitorChatMessageInput } from "@/types/chat";

const CHAT_SESSION_KEY = "music-event-chat-session-id";
const MAX_ADMIN_DISPLAY_NAME = 50;
const MAX_BODY = 500;
const MAX_VISITOR_BODY = 400;

export class ChatSubmissionError extends Error {
  code: string;
  retryAfterSeconds: number | null;

  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ChatSubmissionError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type SubmitChatMessageResult =
  | { ok: true; message: ChatMessage; duplicate?: boolean }
  | { ok: false; code?: string; message?: string; retryAfterSeconds?: number };

function cleanText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeMessageText(value: string) {
  return value.trim();
}

function unicodeLength(value: string) {
  return Array.from(value).length;
}

function assertBody(body: string) {
  if (!body) throw new Error("Message cannot be empty.");
  if (body.length > MAX_BODY) throw new Error("Message is too long.");
}

function assertEventId(eventId: string | null | undefined) {
  if (!eventId) throw new Error("A current event is required before sending chat messages.");
}

export function getOrCreateChatSessionId() {
  const existing = window.localStorage.getItem(CHAT_SESSION_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.localStorage.setItem(CHAT_SESSION_KEY, next);
  return next;
}

function orderedMessagesQuery() {
  return supabase
    .from("chat_messages")
    .select("*")
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: true });
}

export async function getPublicChatMessages(eventId: string) {
  const { data, error } = await orderedMessagesQuery()
    .eq("event_id", eventId)
    .eq("status", "approved")
    .returns<ChatMessage[]>();

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAdminChatMessages(eventId: string) {
  const { data, error } = await orderedMessagesQuery()
    .eq("event_id", eventId)
    .returns<ChatMessage[]>();

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function sendVisitorMessage(input: CreateVisitorChatMessageInput) {
  assertEventId(input.event_id);
  const body = normalizeMessageText(input.body);
  const clientToken = input.client_token ?? crypto.randomUUID();
  if (!body) throw new ChatSubmissionError("MESSAGE_EMPTY", "Message cannot be empty.");
  if (unicodeLength(body) > MAX_VISITOR_BODY) {
    throw new ChatSubmissionError("MESSAGE_TOO_LONG", "Message must be 400 characters or fewer.");
  }
  if (!input.participant_id) throw new Error("A reserved chat identity is required.");

  const { data, error } = await supabase.rpc("submit_chat_message", {
    p_body: body,
    p_client_token: clientToken,
    p_event_id: input.event_id,
    p_participant_id: input.participant_id,
  });

  if (error) throw new Error(error.message);
  const result = data as SubmitChatMessageResult | null;
  if (!result) throw new Error("Message could not be submitted.");
  if (!result.ok) {
    throw new ChatSubmissionError(
      result.code ?? "MESSAGE_SUBMISSION_FAILED",
      result.message ?? "Message could not be submitted.",
      typeof result.retryAfterSeconds === "number" ? result.retryAfterSeconds : null,
    );
  }
  return result.message;
}

export async function joinEventChatIdentity(input: { event_id: string; session_id?: string }) {
  assertEventId(input.event_id);
  const sessionId = input.session_id ?? getOrCreateChatSessionId();

  const startedAt = performance.now();
  const { data, error } = await supabase.rpc("join_event_chat", {
    p_event_id: input.event_id,
    p_session_id: sessionId,
  });

  if (error) {
    console.error("[chat-join]", {
      operation: "join_event_chat",
      eventId: input.event_id,
      code: error.code,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw new Error("Could not join the chat. Please try again.");
  }

  const participant = Array.isArray(data) ? data[0] : data;
  if (!participant?.id || !participant.session_id || !participant.display_name) {
    console.error("[chat-join]", {
      operation: "join_event_chat",
      eventId: input.event_id,
      code: "invalid_identity_response",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw new Error("Could not join the chat. Please try again.");
  }

  return participant as ChatParticipant;
}

export async function getVisitorMessageStatus(eventId: string, messageId: string, clientToken: string) {
  const { data, error } = await supabase.rpc("get_visitor_chat_message_status", {
    message_event_id: eventId,
    message_id: messageId,
    message_client_token: clientToken,
  });

  if (error) throw new Error(error.message);
  return data as ChatMessageStatus | null;
}

export async function sendAdminMessage(input: CreateAdminChatMessageInput) {
  assertEventId(input.event_id);
  const displayName = cleanText(input.display_name || "Admin", MAX_ADMIN_DISPLAY_NAME);
  const body = cleanText(input.body, MAX_BODY);
  if (!displayName) throw new Error("Display name is required.");
  assertBody(body);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("You must be signed in to send admin messages.");

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      event_id: input.event_id,
      user_id: userData.user.id,
      display_name: displayName,
      body,
      status: "approved",
      is_admin: true,
      is_pinned: false,
      is_highlighted: false,
      is_liked: false,
    })
    .select("*")
    .single<ChatMessage>();

  if (error) throw new Error(error.message);
  return data;
}

export async function setMessageStatus(id: string, status: ChatMessageStatus) {
  const { data, error } = await supabase
    .from("chat_messages")
    .update({ status })
    .eq("id", id)
    .select("*")
    .single<ChatMessage>();

  if (error) throw new Error(error.message);
  return data;
}

export async function updateMessageFlags(id: string, flags: Partial<Pick<ChatMessage, "is_pinned" | "is_highlighted" | "is_liked">>) {
  const { data, error } = await supabase
    .from("chat_messages")
    .update(flags)
    .eq("id", id)
    .select("*")
    .single<ChatMessage>();

  if (error) throw new Error(error.message);
  return data;
}

export async function setMessagePinned(id: string, pinned: boolean) {
  const { error } = await supabase.rpc("set_chat_message_pin", {
    p_message_id: id,
    p_pinned: pinned,
  });

  if (error) throw new Error(error.message);
}

export async function setMessageHighlighted(id: string, highlighted: boolean) {
  const { error } = await supabase.rpc("set_chat_message_highlight", {
    p_message_id: id,
    p_highlighted: highlighted,
  });

  if (error) throw new Error(error.message);
}

export async function deleteChatMessage(id: string) {
  const { error } = await supabase.from("chat_messages").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
