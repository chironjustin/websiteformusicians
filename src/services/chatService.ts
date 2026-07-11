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

export async function sendAdminMessage(input: CreateAdminChatMessageInput) {
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

export async function deleteChatMessage(id: string) {
  const { error } = await supabase.from("chat_messages").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
