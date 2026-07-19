import { supabase } from "@/lib/supabase";
import { assertEventReadyToStart, EventReadinessError } from "@/lib/eventReadiness";
import type { CreateEventInput, MusicEvent, UpdateEventInput } from "@/types/event";

const PUBLIC_STATUSES = ["upcoming", "live", "finished"];
type PublicSelectionReason = "live" | "upcoming" | "finished";

function toUsefulError(error: unknown, fallback: string) {
  if (error instanceof EventReadinessError) return error;
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

async function requireUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in to manage events.");
  return data.user.id;
}

export async function getCurrentPublicEvent() {
  const now = new Date().toISOString();

  const live = await selectCurrentPublicEventByReason("live", now);
  if (live) return live;

  const upcoming = await selectCurrentPublicEventByReason("upcoming", now);
  if (upcoming) return upcoming;

  return selectCurrentPublicEventByReason("finished", now);
}

async function selectCurrentPublicEventByReason(reason: PublicSelectionReason, now: string) {
  const query = supabase
    .from("events")
    .select("*")
    .in("status", PUBLIC_STATUSES);

  const orderedQuery = reason === "live"
    ? query
      .not("starts_at", "is", null)
      .not("ends_at", "is", null)
      .not("audio_path", "is", null)
      .not("artist_image_path", "is", null)
      .not("artist_name", "is", null)
      .lte("starts_at", now)
      .gt("ends_at", now)
      .in("status", ["upcoming", "live"])
      .order("starts_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
    : reason === "upcoming"
      ? query
        .not("starts_at", "is", null)
        .not("audio_path", "is", null)
        .not("artist_image_path", "is", null)
        .not("artist_name", "is", null)
        .gt("starts_at", now)
        .eq("status", "upcoming")
        .order("starts_at", { ascending: true, nullsFirst: false })
        .order("updated_at", { ascending: false })
      : query
        .not("ends_at", "is", null)
        .not("audio_path", "is", null)
        .not("artist_image_path", "is", null)
        .not("artist_name", "is", null)
        .lte("ends_at", now)
        .in("status", ["upcoming", "live", "finished"])
        .order("ends_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false });

  const { data, error } = await orderedQuery.limit(1).maybeSingle<MusicEvent>();

  if (error) throw toUsefulError(error, "Unable to load the current event.");
  if (data) {
    console.info("Selected public event", {
      selectionReason: reason,
      eventId: data.id,
      title: data.title,
      status: data.status,
      startsAt: data.starts_at,
      endsAt: data.ends_at,
      audioPathPresent: Boolean(data.audio_path),
    });
  }
  return data;
}

export async function getAdminEvents() {
  await requireUserId();
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<MusicEvent[]>();

  if (error) throw toUsefulError(error, "Unable to load admin events.");
  return data ?? [];
}

export async function getEventById(id: string) {
  const { data, error } = await supabase.from("events").select("*").eq("id", id).maybeSingle<MusicEvent>();
  if (error) throw toUsefulError(error, "Unable to load event.");
  return data;
}

export async function createEvent(input: CreateEventInput) {
  const ownerId = await requireUserId();
  const { data, error } = await supabase
    .from("events")
    .insert({ ...input, owner_id: ownerId, status: input.status ?? "draft" })
    .select("*")
    .single<MusicEvent>();

  if (error) throw toUsefulError(error, "Unable to create event.");
  return data;
}

export async function updateEvent(id: string, input: UpdateEventInput) {
  await requireUserId();
  if (input.status === "upcoming" || input.status === "live") {
    const existing = await getEventById(id);
    if (!existing) throw new Error("Event not found.");
    assertEventReadyToStart({ ...existing, ...input });
  }
  const { data, error } = await supabase.from("events").update(input).eq("id", id).select("*").single<MusicEvent>();
  if (error) throw toUsefulError(error, "Unable to update event.");
  return data;
}

export async function setEventChatAutoPublishSettings(
  id: string,
  input: Pick<UpdateEventInput, "auto_publish_enabled" | "queue_paused">,
) {
  await requireUserId();
  const { data, error } = await supabase.rpc("set_event_chat_auto_publish_settings", {
    p_auto_publish_enabled: input.auto_publish_enabled ?? null,
    p_event_id: id,
    p_queue_paused: input.queue_paused ?? null,
  });

  if (error) throw toUsefulError(error, "Unable to update chat queue settings.");
  return data as MusicEvent;
}

export async function startEvent(id: string, latest?: UpdateEventInput) {
  const existing = await getEventById(id);
  if (!existing) throw new Error("Event not found.");

  const candidate = { ...existing, ...latest };
  assertEventReadyToStart(candidate);
  const startsAt = new Date(candidate.starts_at!).getTime();
  const endsAt = new Date(candidate.ends_at!).getTime();
  const now = Date.now();

  if (now >= endsAt) {
    throw new Error("Event End Date and Time has already passed. Choose a future end time before starting.");
  }

  return updateEvent(id, {
    ...latest,
    status: now >= startsAt ? "live" : "upcoming",
  });
}

export async function endEvent(id: string) {
  return updateEvent(id, { status: "finished", ends_at: new Date().toISOString() });
}

export async function deleteEvent(id: string) {
  await requireUserId();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw toUsefulError(error, "Unable to delete event.");
}

export type DeleteArchivedEventResult = {
  deleted: boolean;
  eventId: string;
  deletedChatMessages: number;
  collectedStorageRefs: Array<{ bucket: string; column: string; path: string }>;
  verifiedRemovedStorage: Array<{ bucket: string; column: string; path: string; parentFolder: string; basename: string }>;
  notFoundBeforeDelete: Array<{ bucket: string; column: string; path: string; parentFolder: string; basename: string; reason: string }>;
  stillPresentStorage: Array<{ bucket: string; column: string; path: string; parentFolder: string; basename: string; error: string }>;
  preservedSharedStorage: Array<{ bucket: string; column: string; path: string }>;
  invalidStorageRefs: Array<{ bucket: string; column: string; originalValue: string; reason: string }>;
  storageFailures: Array<{ bucket: string; path: string; column?: string; originalValue?: string; error: string }>;
};

export async function deleteArchivedEvent(id: string) {
  await requireUserId();
  const { data, error } = await supabase.functions.invoke<DeleteArchivedEventResult>("delete-archived-event", {
    body: { eventId: id },
  });

  if (error) throw toUsefulError(error, "Unable to permanently delete archived event.");
  if (!data?.deleted) throw new Error("Archived event was not deleted.");

  return data;
}
