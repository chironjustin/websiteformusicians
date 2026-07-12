import { supabase } from "@/lib/supabase";
import type { CreateEventInput, MusicEvent, UpdateEventInput } from "@/types/event";

const PUBLIC_STATUSES = ["upcoming", "live", "finished"];

function toUsefulError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

function validateStartable(event: Partial<MusicEvent>) {
  if (!event.title?.trim()) throw new Error("Add an event title before starting.");
  if (!event.audio_path) throw new Error("Upload an audio file before starting.");
  if (!event.artwork_path && !event.artist_image_path) {
    throw new Error("Upload artwork or an artist image before starting.");
  }
  validateEventWindow(event.starts_at, event.ends_at);
}

function validateEventWindow(startsAt: string | null | undefined, endsAt: string | null | undefined) {
  if (!startsAt) throw new Error("Choose an event start date and time.");
  if (!endsAt) throw new Error("Choose an event end date and time.");

  const startTime = new Date(startsAt).getTime();
  const endTime = new Date(endsAt).getTime();

  if (Number.isNaN(startTime)) throw new Error("Enter a valid event start date and time.");
  if (Number.isNaN(endTime)) throw new Error("Enter a valid event end date and time.");
  if (endTime <= startTime) throw new Error("Event End Date and Time must be later than Event Start Date and Time.");
}

function shiftWindowToNow(startsAt: string, endsAt: string) {
  const startTime = new Date(startsAt).getTime();
  const endTime = new Date(endsAt).getTime();
  const originalLength = endTime - startTime;
  if (!Number.isFinite(originalLength) || originalLength <= 0) {
    throw new Error("Event End Date and Time must be later than Event Start Date and Time.");
  }

  const now = new Date();
  return {
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + originalLength).toISOString(),
  };
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

  const candidate = { ...existing, ...latest };
  validateStartable(candidate);
  const shifted = shiftWindowToNow(candidate.starts_at!, candidate.ends_at!);

  return updateEvent(id, { ...latest, status: "live", ...shifted });
}

export async function endEvent(id: string) {
  return updateEvent(id, { status: "finished", ends_at: new Date().toISOString() });
}

export async function scheduleEvent(id: string, input: UpdateEventInput) {
  if (!input.starts_at) throw new Error("Choose a future start date and time.");
  if (new Date(input.starts_at).getTime() <= Date.now()) throw new Error("Scheduled start time must be in the future.");
  validateStartable(input);
  return updateEvent(id, { ...input, status: "upcoming" });
}

export async function deleteEvent(id: string) {
  await requireUserId();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw toUsefulError(error, "Unable to delete event.");
}
