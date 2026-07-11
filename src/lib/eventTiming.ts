import type { MusicEvent } from "@/types/event";

export type EventDisplayState = "upcoming" | "live" | "finished";

export function getEventDisplayState(event: MusicEvent, now = new Date()): EventDisplayState {
  const endsAt = event.ends_at ? new Date(event.ends_at).getTime() : null;

  if (event.status === "finished" || (endsAt !== null && now.getTime() >= endsAt)) {
    return "finished";
  }

  if (event.status === "live") {
    return "live";
  }

  return "upcoming";
}

export function addHoursUtc(startIso: string, durationHours: number | null | undefined) {
  if (!durationHours || durationHours <= 0) return null;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + durationHours * 60 * 60 * 1000).toISOString();
}

export function getUpcomingCountdownTarget(event: MusicEvent) {
  return event.starts_at;
}

export function getLiveCountdownTarget(event: MusicEvent) {
  return event.ends_at ?? (event.starts_at ? addHoursUtc(event.starts_at, event.duration_hours) : null);
}

export function getRemainingMilliseconds(target: string | null | undefined, now = new Date()) {
  if (!target) return 0;
  const targetTime = new Date(target).getTime();
  if (Number.isNaN(targetTime)) return 0;
  return Math.max(0, targetTime - now.getTime());
}
