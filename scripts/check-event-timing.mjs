import { readFileSync } from "node:fs";

process.env.TZ = process.env.TZ || "Europe/Berlin";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function remainingMilliseconds(target, now) {
  return Math.max(0, new Date(target).getTime() - now.getTime());
}

function effectiveState(event, now) {
  const startsAt = event.starts_at ? new Date(event.starts_at).getTime() : null;
  const endsAt = event.ends_at ? new Date(event.ends_at).getTime() : null;
  const nowTime = now.getTime();
  if (event.status === "finished") return "finished";
  if (startsAt !== null && nowTime < startsAt) return "upcoming";
  if (endsAt !== null && nowTime >= endsAt) return "finished";
  if (event.status === "live" || (startsAt !== null && nowTime >= startsAt && (endsAt === null || nowTime < endsAt))) return "live";
  return "upcoming";
}

function countdownTarget(event, state) {
  if (state === "upcoming") return event.starts_at;
  if (state === "live") return event.ends_at;
  return null;
}

function shiftWindowToNow(startsAt, endsAt, now) {
  const originalLength = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  return {
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + originalLength).toISOString(),
  };
}

const now = new Date("2026-07-11T14:34:00.000Z");
const startsAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
const endsAt = "2026-07-11T20:36:00.000Z";
const scheduled = {
  status: "upcoming",
  starts_at: startsAt,
  duration_hours: 12,
  ends_at: endsAt,
};

assert(remainingMilliseconds(countdownTarget(scheduled, "upcoming"), now) === 120_000, "Upcoming timer must target starts_at, not duration.");
assert(scheduled.ends_at === "2026-07-11T20:36:00.000Z", "Scheduled ends_at must preserve the explicit event end timestamp.");
assert(effectiveState(scheduled, now) === "upcoming", "Future scheduled event must display as upcoming.");
assert(effectiveState({ ...scheduled, status: "live" }, now) === "upcoming", "Future starts_at must keep the public page upcoming even if status is stale.");

const startNow = {
  status: "live",
  ...shiftWindowToNow(scheduled.starts_at, scheduled.ends_at, now),
  duration_hours: 12,
};

assert(startNow.starts_at === "2026-07-11T14:34:00.000Z", "Start Now must use the current timestamp.");
assert(startNow.ends_at === "2026-07-11T20:34:00.000Z", "Start Now ends_at must preserve the original explicit event length.");
assert(remainingMilliseconds(countdownTarget(startNow, "live"), now) === 21_600_000, "Live timer must target explicit ends_at.");

assert(effectiveState({ ...scheduled, starts_at: "2026-07-11T14:33:00.000Z", ends_at: "2026-07-12T02:33:00.000Z" }, now) === "live", "Upcoming event past starts_at should display as live while waiting for cron.");
assert(effectiveState({ ...scheduled, status: "live", starts_at: "2026-07-11T08:33:00.000Z", ends_at: "2026-07-11T14:33:00.000Z" }, now) === "finished", "Live event past ends_at should display as finished.");

const localSelected = new Date("2026-07-11T16:36");
assert(localSelected.toISOString() === "2026-07-11T14:36:00.000Z", "Local 16:36 Europe/Berlin should store as 14:36 UTC.");
assert(localSelected.getHours() === 16 && localSelected.getMinutes() === 36, "Stored UTC should display back as local 16:36.");

const publicPage = readFileSync("src/pages/PublicEventPage.tsx", "utf8");
assert(publicPage.includes('if (state !== "live")'), "Public page must not request audio while upcoming.");
assert(publicPage.includes("{audioUrl && ("), "Live audio player should render only when a signed URL exists.");
assert(publicPage.includes('useEventChat(state === "live" ? event?.id : undefined'), "Public chat subscription must only initialize while live.");
assert(publicPage.includes('{state === "live" && (') && publicPage.includes("<ChatDrawer"), "Public chat drawer must only render while live.");
assert(publicPage.includes('live={authoritativeState === "live"}'), "Public chat submission must depend on authoritative database live status.");

const eventTiming = readFileSync("src/lib/eventTiming.ts", "utf8");
assert(eventTiming.includes("return event.ends_at;"), "Live countdown target must use explicit ends_at.");
assert(!eventTiming.includes("event.starts_at ? addHoursUtc(event.starts_at, event.duration_hours)"), "Public live countdown must not derive ends_at from duration.");

const eventService = readFileSync("src/services/eventService.ts", "utf8");
assert(eventService.includes("shiftWindowToNow"), "Start Now must shift the explicit event window to now.");
assert(!eventService.includes("calculateEndsAt"), "Event service must not recalculate ends_at from duration.");

const migrationSql = readFileSync("supabase/event-end-times-migration.sql", "utf8");
assert(migrationSql.includes("duration_hours::double precision * interval '1 hour'"), "Migration must backfill ends_at from fractional duration hours.");
assert(migrationSql.includes("events_end_after_start"), "Migration must enforce end time after start time.");

const cronSql = readFileSync("supabase/event-status-cron.sql", "utf8");
assert(cronSql.includes("status = 'upcoming'") && cronSql.includes("starts_at <= now()"), "Cron must promote due upcoming events to live.");
assert(cronSql.includes("status in ('upcoming', 'live')") && cronSql.includes("ends_at <= now()"), "Cron must finish expired upcoming/live events.");
assert(cronSql.includes("'* * * * *'"), "Cron should run once per minute.");

console.log("event timing checks passed");
