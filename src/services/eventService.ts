import { supabase } from "@/lib/supabase";
import type { CreateEventInput, MusicEvent, UpdateEventInput } from "@/types/event";

const PUBLIC_STATUSES = ["upcoming", "live", "finished"];

function toUsefulError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

function calculateEndsAt(startsAt: string | null | undefined, durationHours: number | null | undefined) {
  if (!startsAt || !durationHours || durationHours <= 0) return null;
  return new Date(new Date(startsAt).getTime() + durationHours * 60 * 60 * 1000).toISOString();
}

function validateStartable(event: Partial<MusicEvent>) {
  if (!event.title?.trim()) throw new Error("Add an event title before starting.");
  if (!event.audio_path) throw new Error("Upload an audio file before starting.");
  if (!event.artwork_path && !event.artist_image_path) {
    throw new Error("Upload artwork or an artist image before starting.");
  }
  if (!event.ends_at && (!event.duration_hours || event.duration_hours <= 0)) {
    throw new Error("Add a valid duration or end time before starting.");
  }
}

async function requireUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in to manage events.");
  return data.user.id;
}

export async function getCurrentPublicEvent() {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .in("status", PUBLIC_STATUSES)
    .order("starts_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<MusicEvent>();

  if (error) throw toUsefulError(error, "Unable to load the current event.");
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
  const { data, error } = await supabase.from("events").update(input).eq("id", id).select("*").single<MusicEvent>();
  if (error) throw toUsefulError(error, "Unable to update event.");
  return data;
}

export async function startEvent(id: string, latest?: UpdateEventInput) {
  const existing = await getEventById(id);
  if (!existing) throw new Error("Event not found.");

  const now = new Date().toISOString();
  const candidate = { ...existing, ...latest, starts_at: now };
  const endsAt = latest?.ends_at ?? calculateEndsAt(now, candidate.duration_hours) ?? existing.ends_at;
  validateStartable({ ...candidate, ends_at: endsAt });

  return updateEvent(id, { ...latest, status: "live", starts_at: now, ends_at: endsAt });
}

export async function endEvent(id: string) {
  return updateEvent(id, { status: "finished", ends_at: new Date().toISOString() });
}

export async function scheduleEvent(id: string, input: UpdateEventInput) {
  if (!input.starts_at) throw new Error("Choose a future start date and time.");
  if (new Date(input.starts_at).getTime() <= Date.now()) throw new Error("Scheduled start time must be in the future.");
  validateStartable(input);
  const endsAt = input.ends_at ?? calculateEndsAt(input.starts_at, input.duration_hours);
  return updateEvent(id, { ...input, status: "upcoming", ends_at: endsAt });
}

export async function deleteEvent(id: string) {
  await requireUserId();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw toUsefulError(error, "Unable to delete event.");
}
