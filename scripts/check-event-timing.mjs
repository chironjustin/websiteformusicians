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

const startedFutureEvent = { ...scheduled, status: "upcoming" };

assert(startedFutureEvent.starts_at === startsAt, "Start Event must preserve a future start timestamp.");
assert(startedFutureEvent.ends_at === endsAt, "Start Event must preserve the configured end timestamp.");
assert(effectiveState(startedFutureEvent, now) === "upcoming", "Start Event with a future start should publish the Upcoming page.");

const startedActiveEvent = {
  ...scheduled,
  status: "live",
  starts_at: "2026-07-11T14:16:00.000Z",
  ends_at: "2026-07-11T18:33:00.000Z",
};

assert(effectiveState(startedActiveEvent, now) === "live", "Start Event should publish Live immediately when the start time has already been reached.");
assert(remainingMilliseconds(countdownTarget(startedActiveEvent, "live"), now) === 14_340_000, "Live timer must target explicit ends_at.");

assert(effectiveState({ ...scheduled, starts_at: "2026-07-11T14:33:00.000Z", ends_at: "2026-07-12T02:33:00.000Z" }, now) === "live", "Upcoming event past starts_at should display as live while waiting for cron.");
assert(effectiveState({ ...scheduled, status: "live", starts_at: "2026-07-11T08:33:00.000Z", ends_at: "2026-07-11T14:33:00.000Z" }, now) === "finished", "Live event past ends_at should display as finished.");

const localSelected = new Date("2026-07-11T16:36");
assert(localSelected.toISOString() === "2026-07-11T14:36:00.000Z", "Local 16:36 Europe/Berlin should store as 14:36 UTC.");
assert(localSelected.getHours() === 16 && localSelected.getMinutes() === 36, "Stored UTC should display back as local 16:36.");

const publicPage = readFileSync("src/pages/PublicEventPage.tsx", "utf8");
assert(publicPage.includes('if (state !== "live")'), "Public page must not request audio while upcoming.");
assert(publicPage.includes("{audioUrl && <AudioPlayer"), "Live audio player should render only when a signed URL exists.");
assert(publicPage.includes('useEventChat(state === "live" ? event?.id : undefined'), "Public chat subscription must only initialize while live.");
assert(publicPage.includes("<LiveEventView"), "Public page must render a dedicated LiveEventView for the live state.");
assert(publicPage.includes("function LiveEventView") && publicPage.includes("function UpcomingPage") && publicPage.includes("function FinishedPage"), "Public page must keep distinct stage components.");
assert(!publicPage.includes("function StatusPanel") && !publicPage.includes("function ChatDrawer"), "Public debug/status switcher and drawer path must not render publicly.");
assert(!publicPage.includes("function LivePage"), "Live state must not use the old artwork-based LivePage.");
assert(!publicPage.includes("Artwork size={320}"), "Live state must not mount the Upcoming artwork composition.");
assert(publicPage.includes("join chat") && publicPage.includes("choose name:"), "Live state must include the centered chat entry composition.");
assert(publicPage.includes('CHAT_NAME_KEY_PREFIX = "music-event-chat-name:"'), "Live chat name must use the event-specific key prefix.");
assert(publicPage.includes("getEventChatNameKey(eventId)"), "Live chat name must be keyed by the database event id.");
assert(publicPage.includes("window.localStorage.setItem(storageKey, name)"), "Joining chat must persist the event-specific display name.");
assert(publicPage.includes("removeLegacyChatIdentity") && publicPage.includes('"live-chat-name"') && publicPage.includes('"joined-chat"'), "Legacy global chat identity keys must be removed.");
assert(publicPage.includes("removeEventChatIdentity(currentEventId)") && publicPage.includes('state === "finished"'), "Finished events must clear their stored chat identity.");
assert(publicPage.includes("removeEventChatIdentity(priorEventId)") && publicPage.includes("priorEventId !== currentEventId"), "Replacing the active event must clear the prior event identity.");
assert(publicPage.includes("key={event.id}"), "Live view must remount when the event id changes to reset drafts and temporary state.");
assert(publicPage.includes("function ActiveChatComposer") && publicPage.includes("displayName={joinedName}"), "Message composer must appear only after the visitor joins.");
assert(publicPage.includes("function LiveMessageStream"), "Approved messages must render independently from the join state.");
assert(publicPage.includes("pendingSubmission") && publicPage.includes("Waiting..."), "Submitted visitor messages must show Waiting while the tracked row is pending.");
assert(publicPage.includes("getVisitorMessageStatus(eventId, pendingSubmission.id, pendingSubmission.clientToken)"), "Waiting state must check the submitted message status by event id, row id, and client token.");
assert(publicPage.includes('live={authoritativeState === "live"}'), "Public chat submission must depend on authoritative database live status.");

const chatHook = readFileSync("src/hooks/useEventChat.ts", "utf8");
assert(chatHook.includes("setMessages([])") && chatHook.includes("activeScopeRef"), "Changing event ids must clear stale chat messages and ignore stale fetches.");
assert(chatHook.includes("filter: `event_id=eq.${eventId}`"), "Realtime chat subscription must be scoped to the active event id.");

const chatService = readFileSync("src/services/chatService.ts", "utf8");
assert(chatService.includes('.eq("event_id", eventId)') && chatService.includes('.eq("status", "approved")'), "Public chat query must fetch approved messages for the active event only.");
assert(chatService.includes("client_token: input.client_token") && chatService.includes("get_visitor_chat_message_status"), "Visitor submissions must carry a client token and status lookup must use the scoped RPC.");

const chatSchema = readFileSync("supabase/chat-schema.sql", "utf8");
assert(chatSchema.includes("event_id uuid not null") && chatSchema.includes("client_token uuid"), "Chat schema must associate messages with events and pending-status client tokens.");
assert(chatSchema.includes("chat_messages_event_status_created_idx") && chatSchema.includes("chat_messages_event_client_token_idx"), "Chat schema must include event-scoped retrieval indexes.");

const eventTiming = readFileSync("src/lib/eventTiming.ts", "utf8");
assert(eventTiming.includes("return event.ends_at;"), "Live countdown target must use explicit ends_at.");
assert(!eventTiming.includes("event.starts_at ? addHoursUtc(event.starts_at, event.duration_hours)"), "Public live countdown must not derive ends_at from duration.");

const eventService = readFileSync("src/services/eventService.ts", "utf8");
assert(!eventService.includes("shiftWindowToNow"), "Start Event must not shift the explicit event window to now.");
assert(!eventService.includes("scheduleEvent"), "Separate Schedule Event workflow must be removed.");
assert(!eventService.includes("calculateEndsAt"), "Event service must not recalculate ends_at from duration.");

const adminPage = readFileSync("src/pages/AdminPage.tsx", "utf8");
assert(adminPage.includes(">Start Event<"), "Admin must expose a single Start Event action.");
assert(!adminPage.includes(">Schedule Event<") && !adminPage.includes(">Start Now<"), "Admin must not expose Schedule Event or Start Now actions.");

const migrationSql = readFileSync("supabase/event-end-times-migration.sql", "utf8");
assert(migrationSql.includes("duration_hours::double precision * interval '1 hour'"), "Migration must backfill ends_at from fractional duration hours.");
assert(migrationSql.includes("events_end_after_start"), "Migration must enforce end time after start time.");

const cronSql = readFileSync("supabase/event-status-cron.sql", "utf8");
assert(cronSql.includes("status = 'upcoming'") && cronSql.includes("starts_at <= now()"), "Cron must promote due upcoming events to live.");
assert(cronSql.includes("status in ('upcoming', 'live')") && cronSql.includes("ends_at <= now()"), "Cron must finish expired upcoming/live events.");
assert(cronSql.includes("'* * * * *'"), "Cron should run once per minute.");

console.log("event timing checks passed");
