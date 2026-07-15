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
assert(publicPage.includes("<AudioPlayer audioUrl={audioUrl}") && publicPage.includes("sourceStatus={audioSourceStatus}") && publicPage.includes("startsAt={startsAt}"), "Live must keep the audio controls mounted in the compact header with explicit audio-source state.");
assert(publicPage.includes('aria-label={playing ? "Pause live audio" : "Resume live audio"}'), "Live play control must remain an accessible resume/pause control.");
assert(publicPage.includes('loop') && publicPage.includes('playsInline') && publicPage.includes('preload="metadata"'), "Live audio must use the shared mobile-ready audio element.");
assert(publicPage.includes("onLoadedMetadata={handleMediaReady}") && publicPage.includes("onDurationChange={handleMediaReady}") && publicPage.includes("onCanPlay={handleMediaReady}"), "Live audio readiness must be handled declaratively on the real audio element.");
assert(publicPage.includes("getUsableDuration") && publicPage.includes("audioRef.current?.duration"), "Live audio must use the real media duration when metadata is already available.");
assert(publicPage.includes("readyState >= HTMLMediaElement.HAVE_METADATA"), "Live audio must initialize already-loaded metadata.");
assert(publicPage.includes('sourceStatus === "loading"') && publicPage.includes('sourceStatus === "error"') && publicPage.includes("audio unavailable"), "Live audio must expose loading and unavailable signed-URL states.");
assert(publicPage.includes("Live audio signed URL failed") && publicPage.includes("sanitizeUrlForLog"), "Signed URL failures must be logged safely instead of swallowed.");
assert(publicPage.includes("const disabled = !audioUrl;"), "Resume must be enabled as soon as a signed audio URL exists.");
assert(publicPage.includes("nativeAudioTest") && publicPage.includes("function NativeAudioTestPlayer") && publicPage.includes("controls") && publicPage.includes("AUDIO ELEMENT MOUNTED"), "Native audio test mode must be available behind the diagnostic query string.");
assert(publicPage.includes('type="button"') && publicPage.includes('width: "2.75rem"') && publicPage.includes('pointerEvents: "auto"') && publicPage.includes('touchAction: "manipulation"'), "Live play control must stay tappable on mobile.");
assert(publicPage.includes('pointerEvents: "none"') && publicPage.includes('role="progressbar"'), "Live audio progress must remain visual-only and non-seekable.");
assert(!publicPage.includes("durationRef") && !publicPage.includes("playingRef") && !publicPage.includes("pendingResumeRef"), "Live audio must not use duplicate ref-based controller state.");
assert(publicPage.includes("const audioRef = useRef<HTMLAudioElement>(null)") && publicPage.includes("const [progress, setProgress]") && publicPage.includes("const [duration, setDuration]"), "Live audio must use one shared audio ref and state controller.");
assert(publicPage.includes("return elapsed % usableDuration") && publicPage.includes("setProgress(livePosition)") && publicPage.includes("window.setInterval"), "Live progress must derive from the event timeline.");
assert(publicPage.includes("flexWrap: \"nowrap\"") && publicPage.includes("<CompactLiveCountdown target={liveTarget} />"), "Live header must keep title, audio player, and event countdown in one compact row.");
assert(publicPage.includes("function ChatMessageBubble") && publicPage.includes("const pinnedMessage = messages.find"), "Live chat must render pinned content in a reserved area before the feed.");
assert(publicPage.includes('useEventChat(state === "live" ? event?.id : undefined'), "Public chat subscription must only initialize while live.");
assert(publicPage.includes("<LiveEventView"), "Public page must render a dedicated LiveEventView for the live state.");
assert(publicPage.includes("function LiveEventView") && publicPage.includes("function UpcomingPage") && publicPage.includes("function FinishedPage"), "Public page must keep distinct stage components.");
assert(!publicPage.includes("function StatusPanel") && !publicPage.includes("function ChatDrawer"), "Public debug/status switcher and drawer path must not render publicly.");
assert(!publicPage.includes("function LivePage"), "Live state must not use the old artwork-based LivePage.");
assert(!publicPage.includes("Artwork size={320}"), "Live state must not mount the Upcoming artwork composition.");
assert(publicPage.includes("join chat") && publicPage.includes("[ join ]"), "Live state must include the one-click chat join composition.");
assert(!publicPage.includes("choose name:") && !publicPage.includes('aria-label="Display name"'), "Live chat onboarding must not render a username input.");
assert(publicPage.includes('CHAT_NAME_KEY_PREFIX = "music-event-chat-name:"'), "Live chat name must use the event-specific key prefix.");
assert(publicPage.includes("getEventChatNameKey(eventId)"), "Live chat name must be keyed by the database event id.");
assert(publicPage.includes("storeChatIdentity(eventId, identity)") && publicPage.includes("getEventChatParticipantKey(eventId)"), "Joining chat must persist the event-specific participant identity.");
assert(publicPage.includes("removeLegacyChatIdentity") && publicPage.includes('"live-chat-name"') && publicPage.includes('"joined-chat"'), "Legacy global chat identity keys must be removed.");
assert(publicPage.includes("removeEventChatIdentity(currentEventId)") && publicPage.includes('state === "finished"'), "Finished events must clear their stored chat identity.");
assert(publicPage.includes("removeEventChatIdentity(priorEventId)") && publicPage.includes("priorEventId !== currentEventId"), "Replacing the active event must clear the prior event identity.");
assert(publicPage.includes("key={event.id}"), "Live view must remount when the event id changes to reset drafts and temporary state.");
assert(publicPage.includes("function ActiveChatComposer") && publicPage.includes("identity={joinedIdentity}"), "Message composer must appear only after the visitor joins.");
assert(publicPage.includes("function LiveMessageStream"), "Approved messages must render independently from the join state.");
assert(!publicPage.includes("joined || message.is_admin"), "Pre-join approved messages must not use alternate hidden message markup.");
assert(!publicPage.includes("ChatAvatar") && !publicPage.includes("ArtistMessageAvatar") && !publicPage.includes("createRetroAvatar"), "Public chat messages and composer must not render generated identity avatars.");
assert(!publicPage.includes("avatarId") && !publicPage.includes("CHAT_AVATAR_KEY_PREFIX"), "Stored generated chat identities must not include avatar metadata.");
assert(publicPage.includes("VISITOR_MESSAGE_LIMIT = 400") && publicPage.includes("getUnicodeLength(body.trim())"), "Visitor composer must count trimmed Unicode characters against the 400-character limit.");
assert(publicPage.includes("pendingSubmissions") && publicPage.includes("Waiting..."), "Submitted visitor messages must show Waiting while tracked rows are pending.");
assert(publicPage.includes("pendingSubmissions.map") && publicPage.includes("getVisitorMessageStatus(eventId, submission.id, submission.clientToken)"), "Waiting state must independently check each submitted message status by event id, row id, and client token.");
assert(!publicPage.includes("pendingSubmission)") && !publicPage.includes("8_000") && !publicPage.includes("lastSentAt"), "Visitor composer must not block new sends merely because another message is pending or because of a fixed local cooldown.");
assert(publicPage.includes("cooldownRemaining") && publicPage.includes("Wait a little till sending again.") && publicPage.includes("formatCooldown"), "Visitor composer must show a server-provided cooldown countdown.");
assert(publicPage.includes('live={authoritativeState === "live"}'), "Public chat submission must depend on authoritative database live status.");

const chatHook = readFileSync("src/hooks/useEventChat.ts", "utf8");
assert(chatHook.includes("setMessages([])") && chatHook.includes("activeScopeRef"), "Changing event ids must clear stale chat messages and ignore stale fetches.");
assert(chatHook.includes("filter: `event_id=eq.${eventId}`"), "Realtime chat subscription must be scoped to the active event id.");

const chatService = readFileSync("src/services/chatService.ts", "utf8");
assert(chatService.includes('.eq("event_id", eventId)') && chatService.includes('.eq("status", "approved")'), "Public chat query must fetch approved messages for the active event only.");
assert(chatService.includes('supabase.rpc("submit_chat_message"') && chatService.includes("p_client_token") && chatService.includes("get_visitor_chat_message_status"), "Visitor submissions must use the scoped public RPC and pending-status lookup.");
assert(chatService.includes("ChatSubmissionError") && chatService.includes("retryAfterSeconds") && chatService.includes("result.code") && chatService.includes("result.message"), "Visitor submission service must map structured server errors, including rate-limit metadata.");
assert(chatService.includes("MAX_VISITOR_BODY = 400") && chatService.includes("unicodeLength(body) > MAX_VISITOR_BODY") && !chatService.includes("normalizeMessageText(input.body).slice"), "Visitor submission service must validate but never silently truncate 400-character messages.");
assert(chatService.includes("joinEventChatIdentity") && chatService.includes("getOrCreateChatSessionId") && chatService.includes('supabase.rpc("join_event_chat"'), "Visitor chat names must use one-click event-scoped server-generated identity creation.");
assert(chatService.includes("Array.isArray(data) ? data[0] : data") && chatService.includes("invalid_identity_response"), "Generated identity RPC responses must unwrap the single table-return row before joining chat.");
assert(!chatService.includes("reserve_event_chat_identity") && !chatService.includes("p_display_name") && !chatService.includes("p_normalized_name"), "The client must not call the old manual identity reservation RPC or submit generated name fields.");
assert(!chatService.includes("avatar") && !chatService.includes("USER_AVATAR_IDS"), "The one-click generated identity client must not send, validate, or assign avatars.");
assert(chatService.includes('supabase.rpc("set_chat_message_pin"') && chatService.includes('supabase.rpc("set_chat_message_highlight"'), "Pin and highlight actions must use event-scoped RPC helpers.");
assert(chatService.includes("p_message_id") && chatService.includes("p_pinned") && chatService.includes("p_highlighted"), "Pin and highlight RPC calls must use the deployed p_ argument names.");

const publicLivePage = readFileSync("src/pages/PublicEventPage.tsx", "utf8");
assert(publicLivePage.includes("live ends {label}"), "Live header must show the compact event-end countdown label.");

const chatSchema = readFileSync("supabase/chat-schema.sql", "utf8");
assert(chatSchema.includes("event_id uuid references public.events") && chatSchema.includes("client_token uuid"), "Chat schema must associate messages with events and pending-status client tokens.");
assert(chatSchema.includes("chat_messages_event_status_created_idx") && chatSchema.includes("chat_messages_event_client_token_idx"), "Chat schema must include event-scoped retrieval indexes.");
assert(chatSchema.includes("chat_messages_event_participant_client_token_idx"), "Chat schema must enforce idempotent visitor submissions by event, participant, and client token.");
assert(chatSchema.includes("create or replace function public.submit_chat_message"), "Chat schema must provide a public pending-message submit RPC.");
assert(chatSchema.includes("create table if not exists public.event_chat_participants") && chatSchema.includes("event_chat_participants_event_normalized_name_idx"), "Chat schema must enforce event-scoped temporary username uniqueness.");
assert(chatSchema.includes("session_id uuid") && chatSchema.includes("event_chat_participants_event_session_idx"), "Chat schema must preserve generated chat identity by event and session.");
assert(chatSchema.includes("create or replace function public.join_event_chat"), "Chat schema must generate anonymous event identities server-side.");
assert(chatSchema.includes("drop function if exists public.chat_generated_first_names()") && !chatSchema.includes("create or replace function public.chat_generated_first_names"), "Chat schema must remove, not recreate, the obsolete synthetic generated-name helper.");
assert(chatSchema.includes("from public.pick_chat_base_name(event_artist_name) picked") && chatSchema.includes("for suffix_number in 1..50"), "Chat schema must use the curated name pool with sequential event-level suffixes.");
assert(chatSchema.includes("should_reassign_existing") && chatSchema.includes("regexp_replace(existing_participant.display_name"), "Chat schema must repair existing synthetic participant names on the next join.");
assert(chatSchema.includes("revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated"), "Participant identity rows must not be directly enumerable by public clients.");
assert(chatSchema.includes("returns table") && !chatSchema.includes("p_avatar_id text") && !chatSchema.includes("avatar :="), "Generated identity RPC must return only identity fields and must not accept or assign avatars.");
assert(chatSchema.includes("revoke insert on public.chat_messages from anon"), "Anonymous visitors must not rely on fragile direct table inserts.");
assert(chatSchema.includes("returns jsonb") && chatSchema.includes("MESSAGE_RATE_LIMITED") && chatSchema.includes("retryAfterSeconds"), "Visitor submit RPC must return structured JSON errors including rate-limit metadata.");
assert(chatSchema.includes("char_length(btrim(body)) between 1 and 400") && chatSchema.includes("char_length(normalized_body) > 400"), "Visitor submit path must enforce the 400-character trimmed body limit in schema and RPC.");
assert(chatSchema.includes("coalesce(p_body, '') ~ '[[:cntrl:]]'") && chatSchema.includes("MESSAGE_INVALID_CHARACTERS"), "Visitor submit RPC must reject prohibited control characters.");
assert(chatSchema.includes("pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_participant_id::text))"), "Visitor submit RPC must lock per event and participant before idempotency/rate-limit checks.");
assert(chatSchema.includes("created_at > now() - interval '2 minutes'") && chatSchema.includes("recent_count >= 3"), "Visitor submit RPC must enforce three accepted submissions per rolling two-minute window.");
assert(chatSchema.includes("MESSAGE_ALREADY_SUBMITTED") && chatSchema.includes("'duplicate', true"), "Visitor submit RPC must handle duplicate client_token retries idempotently.");
assert(chatSchema.includes("events.starts_at <= now()") && chatSchema.includes("events.ends_at > now()"), "Visitor submit RPC must require the active live timestamp window.");
assert(chatSchema.includes("user_id") && chatSchema.includes("is_admin") && chatSchema.includes("is_pinned") && chatSchema.includes("is_highlighted") && chatSchema.includes("is_liked"), "Visitor submit RPC must force non-privileged pending messages.");
assert(chatSchema.includes("Authenticated admins can read unassigned legacy chat messages"), "Chat schema must allow legacy unassigned messages to be reviewed separately.");
assert(chatSchema.includes("set_chat_message_pin") && chatSchema.includes("set_chat_message_highlight") && chatSchema.includes("pg_advisory_xact_lock"), "Chat schema must provide atomic event-scoped pin/highlight helpers.");
assert(chatSchema.includes("p_message_id uuid") && chatSchema.includes("p_pinned boolean") && chatSchema.includes("p_highlighted boolean"), "Chat emphasis RPC signatures must use p_ argument names.");
assert(chatSchema.includes("notify pgrst, 'reload schema'"), "Chat schema must reload the PostgREST schema cache after RPC changes.");

const noAvatarIdentityMigration = readFileSync("supabase/chat-generated-identity-remove-avatars.sql", "utf8");
assert(noAvatarIdentityMigration.includes("alter column avatar_id drop not null") && noAvatarIdentityMigration.includes("drop constraint if exists event_chat_participants_avatar_id_check"), "No-avatar identity migration must make historical avatar columns non-blocking.");
assert(noAvatarIdentityMigration.includes("returns table") && !noAvatarIdentityMigration.includes("p_avatar_id") && !noAvatarIdentityMigration.includes("participant.avatar_id"), "No-avatar identity migration must replace active RPCs without avatar inputs or message avatar copying.");
assert(noAvatarIdentityMigration.includes("should_reassign_existing") && noAvatarIdentityMigration.includes("regexp_replace(existing_participant.display_name"), "No-avatar identity migration must repair existing synthetic participant names on the next join.");

const namePoolMigration = readFileSync("supabase/chat-name-pool-migration.sql", "utf8");
assert(namePoolMigration.includes("create table if not exists public.chat_name_pool") && namePoolMigration.includes("region_group in ('western', 'international')"), "Generated chat names must be stored in a weighted database pool.");
assert(namePoolMigration.includes("chat_name_pool_normalized_name_idx") && namePoolMigration.includes("on conflict (normalized_name)"), "Name pool seeding must deduplicate normalized names.");
assert(namePoolMigration.includes("chat_name_pool_exclusions") && namePoolMigration.includes("extremist/historical abuse") && namePoolMigration.includes("reserved system name"), "Unsafe supplied names must be explicitly excluded with reason categories.");
assert(namePoolMigration.includes("drop function if exists public.chat_generated_first_names()"), "Name-pool migration must remove the obsolete synthetic name generator.");
assert(namePoolMigration.includes("random() < 0.7") && !namePoolMigration.includes("foreign"), "Name pool selection must use the western/international weighting without forbidden terminology.");
assert(namePoolMigration.includes("selected_offset := floor(random() * eligible_count)::integer") && namePoolMigration.includes("order by pool.id") && !namePoolMigration.includes("order by random()"), "Name pool selection must choose a random offset across the full eligible pool instead of relying on row order or order-by-random fallback behavior.");
assert(namePoolMigration.includes("raise log 'chat_name_pick") && namePoolMigration.includes("selected_pool_id"), "Name pool selection must log safe development diagnostics for selected region, pool size, and row id.");
assert(namePoolMigration.includes("should_reassign_existing") && namePoolMigration.includes("regexp_replace(existing_participant.display_name"), "Name-pool migration must repair existing synthetic participant names on the next join.");

const generatedIdentityMigration = readFileSync("supabase/chat-generated-identity-migration.sql", "utf8");
assert(generatedIdentityMigration.includes("drop function if exists public.chat_generated_first_names()") && !generatedIdentityMigration.includes("create or replace function public.chat_generated_first_names"), "Generated identity migration must not recreate the obsolete synthetic name helper.");
assert(generatedIdentityMigration.includes("from public.pick_chat_base_name(event_artist_name) picked") && generatedIdentityMigration.includes("for suffix_number in 1..50"), "Generated identity migration must use the curated name pool with sequential suffixes.");
assert(generatedIdentityMigration.includes("should_reassign_existing") && generatedIdentityMigration.includes("regexp_replace(existing_participant.display_name"), "Generated identity migration must repair existing synthetic participant names on the next join.");

const curatedNameRepairMigration = readFileSync("supabase/chat-curated-name-flow-repair.sql", "utf8");
assert(curatedNameRepairMigration.includes("create table if not exists public.chat_name_pool") && curatedNameRepairMigration.includes("create or replace function public.pick_chat_base_name"), "Curated-name repair migration must install the curated pool and picker when they are missing.");
assert(curatedNameRepairMigration.includes("selected_offset := floor(random() * eligible_count)::integer") && curatedNameRepairMigration.includes("order by pool.id") && !curatedNameRepairMigration.includes("order by random()"), "Curated-name repair migration must sample a random offset across the full eligible pool.");
assert(curatedNameRepairMigration.includes("raise log 'chat_name_pick") && curatedNameRepairMigration.includes("selected_pool_id"), "Curated-name repair migration must log safe name-selection diagnostics.");
assert(curatedNameRepairMigration.includes("drop function if exists public.chat_generated_first_names()") && curatedNameRepairMigration.includes("from public.pick_chat_base_name(event_artist_name) picked"), "Curated-name repair migration must remove the legacy generator and reinstall the pool-backed join function.");
assert(curatedNameRepairMigration.includes("should_reassign_existing") && curatedNameRepairMigration.includes("regexp_replace(existing_participant.display_name"), "Curated-name repair migration must repair old synthetic rows on the next join.");

const obsoleteNameFragments = [
  "prefix(value)",
  "suffix(value)",
  "floor(random() * 990)",
  "floor(random() * array_length",
  "Aiko' ||",
];

for (const [label, source] of [
  ["chat schema", chatSchema],
  ["generated identity migration", generatedIdentityMigration],
  ["no-avatar identity migration", noAvatarIdentityMigration],
  ["name-pool migration", namePoolMigration],
  ["curated name repair migration", curatedNameRepairMigration],
]) {
  for (const fragment of obsoleteNameFragments) {
    assert(!source.includes(fragment), `${label} must not contain obsolete synthetic generated-name fragment: ${fragment}`);
  }
}

assert(noAvatarIdentityMigration.includes("for suffix_number in 1..50") && noAvatarIdentityMigration.includes("suffix_number = 1") && noAvatarIdentityMigration.includes("|| suffix_number::text"), "Generated names must use sequential event-level suffixes instead of random numeric suffixes.");
assert(chatSchema.includes("chat_name_suffix") && generatedIdentityMigration.includes("chat_name_suffix") && noAvatarIdentityMigration.includes("chat_name_suffix") && namePoolMigration.includes("chat_name_suffix") && curatedNameRepairMigration.includes("chat_name_suffix"), "Suffix allocation must log safe development diagnostics when a numeric suffix is added.");
assert(!noAvatarIdentityMigration.includes("floor(random() * 990)") && !namePoolMigration.includes("floor(random() * 990)") && !namePoolMigration.includes("participant.avatar_id"), "New name-pool identity flow must not use random suffixes or restore avatars.");

const eventTiming = readFileSync("src/lib/eventTiming.ts", "utf8");
assert(eventTiming.includes("return event.ends_at;"), "Live countdown target must use explicit ends_at.");
assert(!eventTiming.includes("event.starts_at ? addHoursUtc(event.starts_at, event.duration_hours)"), "Public live countdown must not derive ends_at from duration.");

const eventService = readFileSync("src/services/eventService.ts", "utf8");
assert(!eventService.includes("shiftWindowToNow"), "Start Event must not shift the explicit event window to now.");
assert(!eventService.includes("scheduleEvent"), "Separate Schedule Event workflow must be removed.");
assert(!eventService.includes("calculateEndsAt"), "Event service must not recalculate ends_at from duration.");

const deleteArchivedEventFunction = readFileSync("supabase/functions/delete-archived-event/index.ts", "utf8");
assert(deleteArchivedEventFunction.includes("function normalizeStoragePath") && deleteArchivedEventFunction.includes("new URL(trimmed)"), "Archived event deletion must normalize raw paths and Storage URLs before cleanup.");
assert(!deleteArchivedEventFunction.includes("function cleanPath"), "Archived event deletion must not discard Storage URLs with the old cleanPath helper.");
assert(deleteArchivedEventFunction.includes("preservedSharedStorage") && deleteArchivedEventFunction.includes("invalidStorageRefs"), "Archived event deletion must report shared and invalid storage references.");
assert(deleteArchivedEventFunction.includes("storageObjectExists") && deleteArchivedEventFunction.includes("existsBeforeDelete") && deleteArchivedEventFunction.includes("existsAfterDelete"), "Archived event deletion must verify Storage object existence before and after remove().");
assert(deleteArchivedEventFunction.includes("verifiedRemovedStorage") && deleteArchivedEventFunction.includes("notFoundBeforeDelete") && deleteArchivedEventFunction.includes("stillPresentStorage"), "Archived event deletion must separate verified removals, missing objects, and still-present objects.");

const adminPage = readFileSync("src/pages/AdminPage.tsx", "utf8");
assert(adminPage.includes(">Start Event<"), "Admin must expose a single Start Event action.");
assert(!adminPage.includes(">Schedule Event<") && !adminPage.includes(">Start Now<"), "Admin must not expose Schedule Event or Start Now actions.");
assert(adminPage.includes("getTrustedEventMessages") && adminPage.includes("message.event_id === event.id"), "Admin archive must keep archived messages scoped to their event id.");
assert(!adminPage.includes("Unassigned Legacy Messages") && !adminPage.includes("getUnassignedLegacyChatMessages"), "Admin archive must not render or load the obsolete unassigned legacy messages block.");
assert(adminPage.includes("mutationInFlight") && adminPage.includes("Another event update is still saving"), "Admin event mutations must be locked against overlapping Save Draft and Start Event actions.");
assert(adminPage.includes("assertStoragePathBelongsToEvent") && adminPage.includes("verifyReturnedMediaPaths"), "Admin uploads must verify returned media paths belong to the saved event.");
assert(adminPage.includes("verifyStorageObjectExists") && adminPage.includes("Uploaded audio could not be verified"), "Start Event must verify uploaded Storage objects before publishing.");
assert(adminPage.includes("const savedDraft = await updateEvent(baseEvent.id, updates)") && adminPage.includes("const started = await startEvent(savedDraft.id)"), "Start Event must save media paths before publishing the event.");
assert(adminPage.includes("clearConfirmedPendingFiles(uploadedKeys)") && !adminPage.includes("nextFiles.audio = null"), "Pending files must only clear after Supabase returns the confirmed saved row.");
assert(adminPage.includes("MEDIA_PATH_FIELDS.filter(field => latest[field])"), "Admin diagnostics must log which media keys are included in update payloads.");

const migrationSql = readFileSync("supabase/event-end-times-migration.sql", "utf8");
assert(migrationSql.includes("duration_hours::double precision * interval '1 hour'"), "Migration must backfill ends_at from fractional duration hours.");
assert(migrationSql.includes("events_end_after_start"), "Migration must enforce end time after start time.");

const cronSql = readFileSync("supabase/event-status-cron.sql", "utf8");
assert(cronSql.includes("status = 'upcoming'") && cronSql.includes("starts_at <= now()"), "Cron must promote due upcoming events to live.");
assert(cronSql.includes("status in ('upcoming', 'live')") && cronSql.includes("ends_at <= now()"), "Cron must finish expired upcoming/live events.");
assert(cronSql.includes("'* * * * *'"), "Cron should run once per minute.");

console.log("event timing checks passed");
