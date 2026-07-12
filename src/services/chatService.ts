import { supabase } from "@/lib/supabase";
import type { ChatMessage, ChatMessageStatus, CreateAdminChatMessageInput, CreateVisitorChatMessageInput } from "@/types/chat";

const MAX_DISPLAY_NAME = 50;
const MAX_BODY = 500;

function cleanText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function assertBody(body: string) {
  if (!body) throw new Error("Message cannot be empty.");
  if (body.length > MAX_BODY) throw new Error("Message is too long.");
}

function assertDisplayName(displayName: string) {
  if (!displayName) throw new Error("Display name is required.");
  if (displayName.length > MAX_DISPLAY_NAME) throw new Error("Display name is too long.");
}

function assertEventId(eventId: string | null | undefined) {
  if (!eventId) throw new Error("A current event is required before sending chat messages.");
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
  const displayName = cleanText(input.display_name, MAX_DISPLAY_NAME);
  const body = cleanText(input.body, MAX_BODY);
  assertDisplayName(displayName);
  assertBody(body);

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      event_id: input.event_id,
      display_name: displayName,
      body,
      client_token: input.client_token ?? null,
      status: "pending",
      is_admin: false,
      is_pinned: false,
      is_highlighted: false,
      is_liked: false,
    })
    .select("*")
    .single<ChatMessage>();

  if (error) throw new Error(error.message);
  return data;
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
  const displayName = cleanText(input.display_name || "Admin", MAX_DISPLAY_NAME);
  const body = cleanText(input.body, MAX_BODY);
  assertDisplayName(displayName);
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
    message_id: id,
    pinned,
  });

  if (error) throw new Error(error.message);
}

export async function setMessageHighlighted(id: string, highlighted: boolean) {
  const { error } = await supabase.rpc("set_chat_message_highlight", {
    message_id: id,
    highlighted,
  });

  if (error) throw new Error(error.message);
}

export async function deleteChatMessage(id: string) {
  const { error } = await supabase.from("chat_messages").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function getUnassignedLegacyChatMessages() {
  const { data, error } = await orderedMessagesQuery()
    .is("event_id", null)
    .returns<ChatMessage[]>();

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function assignChatMessageToEvent(messageId: string, eventId: string) {
  assertEventId(eventId);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("You must be signed in to assign legacy messages.");

  const { data, error } = await supabase
    .from("chat_messages")
    .update({
      event_id: eventId,
      legacy_assignment_confirmed_at: new Date().toISOString(),
      legacy_assignment_confirmed_by: userData.user.id,
    })
    .eq("id", messageId)
    .select("*")
    .single<ChatMessage>();

  if (error) throw new Error(error.message);
  return data;
}
