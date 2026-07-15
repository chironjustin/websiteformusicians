import type { MusicEvent } from "@/types/event";

export type EventReadinessField =
  | "song"
  | "artistImage"
  | "artistName"
  | "title"
  | "startsAt"
  | "endsAt"
  | "merchUrl"
  | "merchImage";

export type EventReadinessFieldErrors = Partial<Record<EventReadinessField, string>>;

export type EventReadinessInput = Partial<Pick<
  MusicEvent,
  | "audio_path"
  | "artist_image_path"
  | "artist_name"
  | "title"
  | "starts_at"
  | "ends_at"
  | "merch_image_path"
  | "merch_url"
>>;

export const EVENT_NOT_READY_MESSAGE = "Complete the required event details before starting the event.";

export class EventReadinessError extends Error {
  code = "EVENT_NOT_READY" as const;
  missingFields: EventReadinessField[];
  fieldErrors: EventReadinessFieldErrors;

  constructor(fieldErrors: EventReadinessFieldErrors) {
    super(EVENT_NOT_READY_MESSAGE);
    this.name = "EventReadinessError";
    this.fieldErrors = fieldErrors;
    this.missingFields = Object.keys(fieldErrors) as EventReadinessField[];
  }
}

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

export function isValidHttpsUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function validateEventReadiness(event: EventReadinessInput) {
  const errors: EventReadinessFieldErrors = {};

  if (!hasText(event.audio_path)) {
    errors.song = "Upload a song file before starting the event.";
  }

  if (!hasText(event.artist_image_path)) {
    errors.artistImage = "Upload an artist image before starting the event.";
  }

  if (!hasText(event.artist_name)) {
    errors.artistName = "Add an artist name before starting the event.";
  }

  if (!hasText(event.title)) {
    errors.title = "Add an event title before starting the event.";
  }

  const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : NaN;
  const endsAt = event.ends_at ? new Date(event.ends_at).getTime() : NaN;

  if (!event.starts_at || Number.isNaN(startsAt)) {
    errors.startsAt = "Add the event start date and time.";
  }

  if (!event.ends_at || Number.isNaN(endsAt)) {
    errors.endsAt = "Add the event end date and time.";
  } else if (!Number.isNaN(startsAt) && endsAt <= startsAt) {
    errors.endsAt = "The event end time must be later than the start time.";
  }

  const hasMerchImage = hasText(event.merch_image_path);
  const hasMerchUrl = hasText(event.merch_url);

  if (hasMerchImage && !hasMerchUrl) {
    errors.merchUrl = "Add a merch link or remove the merch image.";
  } else if (!hasMerchImage && hasMerchUrl) {
    errors.merchImage = "Add a merch image or remove the merch link.";
  }

  if (hasMerchUrl && !isValidHttpsUrl(event.merch_url ?? "")) {
    errors.merchUrl = "Enter a valid HTTPS merch link.";
  }

  return {
    ready: Object.keys(errors).length === 0,
    fieldErrors: errors,
    missingFields: Object.keys(errors) as EventReadinessField[],
  };
}

export function assertEventReadyToStart(event: EventReadinessInput) {
  const result = validateEventReadiness(event);
  if (!result.ready) {
    throw new EventReadinessError(result.fieldErrors);
  }
}
