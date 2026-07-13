export type ChatMessageStatus = "pending" | "approved" | "rejected";

export interface ChatMessage {
  id: string;
  event_id: string | null;
  user_id: string | null;
  display_name: string;
  body: string;
  status: ChatMessageStatus;
  client_token: string | null;
  is_admin: boolean;
  is_pinned: boolean;
  is_highlighted: boolean;
  is_liked: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateVisitorChatMessageInput {
  event_id: string;
  display_name: string;
  body: string;
  client_token?: string;
}

export interface CreateAdminChatMessageInput {
  event_id: string;
  body: string;
  display_name?: string;
}
