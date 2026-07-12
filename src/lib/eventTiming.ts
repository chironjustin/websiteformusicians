import type { MusicEvent } from "@/types/event";

export type EventDisplayState = "upcoming" | "live" | "finished";

export function getEventDisplayState(event: MusicEvent, now = new Date()): EventDisplayState {
  const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : null;
  const endsAt = event.ends_at ? new Date(event.ends_at).getTime() : null;
  const nowTime = now.getTime();

  if (event.status === "finished") {
    return "finished";
  }

  if (startsAt !== null && nowTime < startsAt) {
    return "upcoming";
  }

  if (endsAt !== null && nowTime >= endsAt) {
    return "finished";
  }

  if (event.status === "live" || (startsAt !== null && nowTime >= startsAt && (endsAt === null || nowTime < endsAt))) {
    return "live";
  }

  return "upcoming";
}

export function getUpcomingCountdownTarget(event: MusicEvent) {
  return event.starts_at;
}

export function getLiveCountdownTarget(event: MusicEvent) {
  return event.ends_at;
}

export function getCountdownTarget(event: MusicEvent, state: EventDisplayState) {
  if (state === "upcoming") return getUpcomingCountdownTarget(event);
  if (state === "live") return getLiveCountdownTarget(event);
  return null;
}

export function getRemainingMilliseconds(target: string | null | undefined, now = new Date()) {
  if (!target) return 0;
  const targetTime = new Date(target).getTime();
  if (Number.isNaN(targetTime)) return 0;
  return Math.max(0, targetTime - now.getTime());
}

export function formatCountdown(milliseconds: number) {
  const clamped = Math.max(0, milliseconds);
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((clamped % 1000) / 10);

  return { hours, minutes, seconds, centiseconds };
}
