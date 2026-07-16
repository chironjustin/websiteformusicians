export type EventStatus = "draft" | "upcoming" | "live" | "finished";

export interface MusicEvent {
  id: string;
  owner_id: string | null;
  title: string;
  artist_name: string | null;
  status: EventStatus;
  starts_at: string | null;
  ends_at: string | null;
  duration_hours: number | null;
  audio_path: string | null;
  artwork_path: string | null;
  artist_image_path: string | null;
  merch_image_path: string | null;
  support_url: string | null;
  merch_url: string | null;
  event_url: string | null;
  auto_publish_enabled: boolean;
  queue_paused: boolean;
  next_auto_publish_at: string | null;
  last_auto_published_at: string | null;
  current_queue_size: number;
  current_queue_band: string | null;
  last_calculated_delay_ms: number | null;
  last_release_size: number;
  recent_fan_publish_count: number;
  publication_budget_per_minute: number;
  scheduler_version: string | null;
  created_at: string;
  updated_at: string;
}

export type EditableEventFields = Pick<
  MusicEvent,
  | "title"
  | "artist_name"
  | "status"
  | "starts_at"
  | "ends_at"
  | "duration_hours"
  | "audio_path"
  | "artwork_path"
  | "artist_image_path"
  | "merch_image_path"
  | "support_url"
  | "merch_url"
  | "event_url"
  | "auto_publish_enabled"
  | "queue_paused"
  | "next_auto_publish_at"
  | "last_auto_published_at"
  | "current_queue_size"
  | "current_queue_band"
  | "last_calculated_delay_ms"
  | "last_release_size"
  | "recent_fan_publish_count"
  | "publication_budget_per_minute"
  | "scheduler_version"
>;

export type CreateEventInput = Partial<Omit<EditableEventFields, "status">> & {
  title: string;
  status?: EventStatus;
};

export type UpdateEventInput = Partial<EditableEventFields>;
