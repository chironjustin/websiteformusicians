export type ChatMessageStatus = "pending" | "approved" | "rejected";
export type ChatRiskLevel = "low" | "medium" | "high";

export interface ChatMessage {
  id: string;
  event_id: string | null;
  user_id: string | null;
  participant_id: string | null;
  display_name: string;
  body: string;
  status: ChatMessageStatus;
  client_token: string | null;
  is_admin: boolean;
  is_pinned: boolean;
  is_highlighted: boolean;
  is_liked: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
  published_at?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  rejection_reason?: string | null;
  rejection_source?: string | null;
  approval_source?: string | null;
  risk_level?: ChatRiskLevel | null;
  risk_score?: number | null;
  risk_flags?: string[] | null;
  classified_at?: string | null;
  classifier_version?: string | null;
  auto_publish_eligible?: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface ChatParticipant {
  id: string;
  event_id: string;
  session_id: string;
  display_name: string;
  normalized_name: string;
  created_at: string;
  last_seen_at: string;
}

export interface CreateVisitorChatMessageInput {
  event_id: string;
  participant_id: string;
  body: string;
  client_token?: string;
}

export interface CreateAdminChatMessageInput {
  event_id: string;
  body: string;
  display_name?: string;
}
