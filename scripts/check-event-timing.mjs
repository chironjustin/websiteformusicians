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
const eventChatHook = readFileSync("src/hooks/useEventChat.ts", "utf8");
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
assert(publicPage.includes('useEventChat(state === "live" && chatViewer ? event?.id : undefined'), "Public chat subscription must only initialize after live state and verified chat identity exist.");
assert(publicPage.includes("<LiveEventView"), "Public page must render a dedicated LiveEventView for the live state.");
assert(publicPage.includes("function LiveEventView") && publicPage.includes("function UpcomingPage") && publicPage.includes("function FinishedPage"), "Public page must keep distinct stage components.");
assert(publicPage.includes("const hasArtwork = Boolean(artworkUrl.trim())") && publicPage.includes("{hasArtwork && <Artwork size={360} imageUrl={artworkUrl} />}"), "Upcoming page must not render an empty artwork square when no artwork was uploaded.");
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
assert(publicPage.includes('listeners: {listenerCount ?? "—"}') && !publicPage.includes("} msgs"), "Public chat header must display listeners, not message count.");
assert(publicPage.includes("getEventListenerCount(eventId)") && publicPage.includes("setInterval(loadListenerCount, 10000)"), "Public chat must refresh the cumulative listener count without implementing presence heartbeats.");
assert(publicPage.includes("class LiveChatErrorBoundary") && publicPage.includes("Chat is temporarily unavailable.") && publicPage.includes("chatError={chat.error}"), "Live chat failures must render a local fallback instead of blacking out the full live stage.");
assert(publicPage.includes("onListenerCount={setListenerCount}") && publicPage.includes("onListenerCount: (count: number) => void") && publicPage.includes("onListenerCount={onListenerCount}") && !publicPage.includes("onListenerCount={setListenerCount} />"), "Listener-count setter must stay owned by PublicEventPage and be passed explicitly to child join UI.");
assert(publicPage.includes("joinedAt: joinedIdentity.joinedAt") && publicPage.includes("isValidServerTimestamp(parsed.joinedAt)") && publicPage.includes("joinedAt: participant.joined_at"), "Visitor chat cutoff must come from the trusted joined_at returned by the Join action.");
assert(eventChatHook.includes('mode === "public" && !viewer') && eventChatHook.includes('mode === "admin" || Boolean(viewer)'), "Public chat history and realtime must not initialize before a verified joined viewer exists.");
assert(!publicPage.includes("live-chat-stream--prejoin") && !publicPage.includes("live-chat-layout--prejoin") && !publicPage.includes("if (!joined)"), "The removed read-only pre-join chat stream must not be present.");
assert(publicPage.includes("joinedIdentity ? (") && publicPage.includes("<LiveMessageStream messages={messages}") && publicPage.includes("<JoinChatPanel eventId={eventId} listenerCount={listenerCount}"), "Live chat should have one flow: join panel before identity, active stream after identity.");
assert(publicPage.includes('className="live-chat__pinned"') && publicPage.includes("function PinnedMessageArea") && publicPage.indexOf("<PinnedMessageArea") < publicPage.indexOf('className="live-chat__messages"'), "The active pinned message must render below the chat header and outside the scrollable message feed.");
assert(publicPage.includes("messages.find(message => message.is_pinned && message.status === \"approved\")") && publicPage.includes("messages.filter(message => message.id !== pinnedMessage.id)"), "The active approved pin must be selected once and excluded from the normal feed.");
assert(publicPage.includes('className="live-chat__messages"') && publicPage.includes("overflow-y: auto") && publicPage.includes("bottomAnchorRef"), "Joined chat messages must render in a dedicated scroll viewport with a bottom anchor.");
assert(publicPage.includes('className="live-chat-layout"') && publicPage.includes('className="chat-composer"'), "Joined chat composer must be outside the message viewport in the live chat layout.");
assert(publicPage.includes("@media (max-width: 640px)") && publicPage.includes("flex: 1 1 0") && publicPage.includes("height: 0") && publicPage.includes("-webkit-overflow-scrolling: touch"), "Mobile joined chat viewport must have Safari-safe flex and scrolling constraints.");
assert(!publicPage.includes("joined || message.is_admin"), "Pre-join approved messages must not use alternate hidden message markup.");
assert(!publicPage.includes("ChatAvatar") && !publicPage.includes("ArtistMessageAvatar") && !publicPage.includes("createRetroAvatar"), "Public chat messages and composer must not render generated identity avatars.");
assert(!publicPage.includes("avatarId") && !publicPage.includes("CHAT_AVATAR_KEY_PREFIX"), "Stored generated chat identities must not include avatar metadata.");
assert(publicPage.includes("VISITOR_MESSAGE_LIMIT = 400") && publicPage.includes("getUnicodeLength(body.trim())"), "Visitor composer must count trimmed Unicode characters against the 400-character limit.");
assert(!publicPage.includes("{trimmedLength} / {VISITOR_MESSAGE_LIMIT}"), "Visitor composer must not render a public character counter.");
assert(!publicPage.includes("Waiting...") && !publicPage.includes("pendingSubmissions") && !publicPage.includes("getVisitorMessageStatus"), "Visitor composer must not render or track approval-dependent Waiting state.");
assert(!publicPage.includes("pendingSubmission)") && !publicPage.includes("8_000") && !publicPage.includes("lastSentAt"), "Visitor composer must not block new sends merely because another message is pending or because of a fixed local cooldown.");
assert(publicPage.includes("cooldownRemaining") && publicPage.includes("RATE_LIMIT_MESSAGE") && !publicPage.includes("formatCooldown"), "Visitor composer must keep server-provided cooldown state without rendering a public countdown.");
assert(publicPage.includes("feedbackMessage = error") && publicPage.includes('className="chat-composer__feedback"') && publicPage.includes('role={feedbackMessage ? feedbackTone === "error" ? "alert" : "status" : undefined}'), "Visitor composer must render only error feedback in the shared feedback row.");
assert(publicPage.includes('live={authoritativeState === "live"}'), "Public chat submission must depend on authoritative database live status.");

const chatHook = readFileSync("src/hooks/useEventChat.ts", "utf8");
assert(chatHook.includes("setMessages([])") && chatHook.includes("activeScopeRef"), "Changing event ids must clear stale chat messages and ignore stale fetches.");
assert(chatHook.includes("filter: `event_id=eq.${eventId}`"), "Realtime chat subscription must be scoped to the active event id.");
assert(chatHook.includes("getPublicChatMessageDelta") && chatHook.includes("publicCursorRef") && chatHook.includes("publicUpdateCursorRef") && chatHook.includes("privateCursorRef"), "Public chat must use cursor-based delta reads for steady-state message fetching.");
assert(chatHook.includes("scheduleDeltaFetch") && chatHook.includes("PUBLIC_SAFETY_POLL_MS") && !chatHook.includes("getPublicChatMessages"), "Realtime and safety polling must schedule delta fetches instead of full visible-history reloads.");
assert(chatHook.includes('message.visibility_scope === "public_new"') && chatHook.includes('message.visibility_scope === "public_update"') && chatHook.includes("applyActivePinSnapshot"), "Public chat must advance publication and update cursors separately while applying an active-pin snapshot.");

const chatService = readFileSync("src/services/chatService.ts", "utf8");
assert(chatService.includes('supabase.rpc("get_visitor_visible_chat_messages"') && chatService.includes("p_participant_id: viewer.participantId") && chatService.includes("p_session_id: viewer.sessionId"), "Public chat history must use the participant/session-verified visitor RPC.");
assert(chatService.includes('supabase.rpc("get_visitor_visible_chat_message_delta"') && chatService.includes("p_after_published_at") && chatService.includes("p_after_id") && chatService.includes("p_after_public_updated_at") && chatService.includes("p_after_private_updated_at"), "Public chat steady-state reads must use participant/session-verified cursor delta RPC arguments.");
assert(chatService.includes("return []") && !chatService.includes("approvedPublicMessagesQuery"), "Public chat must not fall back to a full approved-message history before the visitor identity is known.");
assert(chatService.includes('supabase.rpc("get_event_listener_count"') && chatService.includes("getEventListenerCount"), "Public chat must fetch the cumulative listener count from the controlled listener-count RPC.");
assert(chatService.includes('.order("created_at", { ascending: true'), "Admin/moderation chat history must continue using submission-time ordering.");
assert(chatService.includes('supabase.rpc("submit_chat_message"') && chatService.includes("p_client_token") && chatService.includes("get_visitor_visible_chat_message_delta"), "Visitor submissions must use the scoped public RPC and joined visitors must load cutoff-aware approved plus sender-private message deltas.");
assert(chatService.includes('supabase.rpc("moderate_chat_message"') && chatService.includes("p_next_status"), "Admin moderation must use the audited moderation RPC.");
assert(chatService.includes("ChatSubmissionError") && chatService.includes("retryAfterSeconds") && chatService.includes("result.code") && chatService.includes("result.message"), "Visitor submission service must map structured server errors, including rate-limit metadata.");
assert(chatService.includes("MAX_VISITOR_BODY = 400") && chatService.includes("unicodeLength(body) > MAX_VISITOR_BODY") && !chatService.includes("normalizeMessageText(input.body).slice"), "Visitor submission service must validate but never silently truncate 400-character messages.");
assert(chatService.includes("joinEventChatIdentity") && chatService.includes("getOrCreateChatSessionId") && chatService.includes('supabase.rpc("join_event_chat"'), "Visitor chat names must use one-click event-scoped server-generated identity creation.");
assert(chatService.includes("Array.isArray(data) ? data[0] : data") && chatService.includes("invalid_identity_response"), "Generated identity RPC responses must unwrap the single table-return row before joining chat.");
assert(!chatService.includes("reserve_event_chat_identity") && !chatService.includes("p_display_name") && !chatService.includes("p_normalized_name"), "The client must not call the old manual identity reservation RPC or submit generated name fields.");
assert(!chatService.includes("avatar") && !chatService.includes("USER_AVATAR_IDS"), "The one-click generated identity client must not send, validate, or assign avatars.");
assert(chatService.includes("VisitorSubmittedChatMessage") && chatService.includes("p_session_id: input.session_id"), "Visitor submission must pass the event-scoped session id and use the allowlisted visitor response type.");
assert(chatService.includes('supabase.rpc("set_chat_message_pin"') && chatService.includes('supabase.rpc("set_chat_message_highlight"'), "Pin and highlight actions must use event-scoped RPC helpers.");
assert(chatService.includes("p_message_id") && chatService.includes("p_pinned") && chatService.includes("p_highlighted"), "Pin and highlight RPC calls must use the deployed p_ argument names.");

const publicLivePage = readFileSync("src/pages/PublicEventPage.tsx", "utf8");
assert(publicLivePage.includes("live ends {label}"), "Live header must show the compact event-end countdown label.");

const chatSchema = readFileSync("supabase/chat-schema.sql", "utf8");
assert(chatSchema.includes("event_id uuid references public.events") && chatSchema.includes("client_token uuid"), "Chat schema must associate messages with events and pending-status client tokens.");
assert(chatSchema.includes("chat_messages_event_status_created_idx") && chatSchema.includes("chat_messages_event_client_token_idx"), "Chat schema must include event-scoped retrieval indexes.");
assert(chatSchema.includes("chat_messages_event_participant_client_token_idx"), "Chat schema must enforce idempotent visitor submissions by event, participant, and client token.");
assert(chatSchema.includes("create or replace function public.submit_chat_message"), "Chat schema must provide a public pending-message submit RPC.");
assert(chatSchema.includes("create or replace function public.chat_message_public_submission_payload") && chatSchema.includes("'published_at', p_message.published_at"), "Visitor submission responses must use an explicit allowlisted payload helper.");
assert(!chatSchema.includes("to_jsonb(inserted_message)") && !chatSchema.includes("to_jsonb(existing_message)"), "Visitor submit RPC must not return complete chat_messages rows.");
assert(chatSchema.includes("create or replace function public.get_visitor_visible_chat_messages") && chatSchema.includes("participant_id = p_participant_id"), "Chat schema must provide sender-private public message visibility.");
assert(chatSchema.includes("create or replace function public.get_visitor_visible_chat_message_delta") && chatSchema.includes("public_new_delta as") && chatSchema.includes("chat_messages.published_at > p_after_published_at") && chatSchema.includes("chat_messages.id > p_after_id"), "Chat schema must provide tuple-cursor visitor message deltas.");
assert(chatSchema.includes("active_pin as") && chatSchema.includes("'active_pin'::text") && chatSchema.includes("public_update_delta as") && chatSchema.includes("p_after_public_updated_at"), "Chat schema must separate active-pin snapshots and public metadata update deltas from the publication cursor.");
assert(chatSchema.includes("joined_at timestamptz not null default now()") && chatSchema.includes("event_chat_participants_event_joined_idx"), "Participant rows must store a trusted immutable chat join timestamp.");
assert(chatSchema.includes("create or replace function public.get_event_listener_count") && chatSchema.includes("from public.event_chat_participants") && chatSchema.includes("grant execute on function public.get_event_listener_count(uuid) to anon, authenticated"), "Chat schema must expose only a controlled cumulative listener-count RPC.");
assert(chatSchema.includes("published_at >= verified_participant.joined_at") && chatSchema.includes("cross join verified_participant"), "Visitor message history must enforce the join-time published_at cutoff in the database RPC.");
assert(chatSchema.includes("published_at <= request.snapshot_at") && chatSchema.includes("updated_at <= request.snapshot_at") && chatSchema.includes("p_after_private_updated_at"), "Visitor delta RPC must use a database snapshot boundary and separate public/private update cursors.");
assert(chatSchema.includes("when chat_messages.participant_id = p_participant_id then chat_messages.client_token") && chatSchema.includes("else null"), "Visitor history RPC must hide other participants' client tokens while preserving own-message reconciliation.");
assert(chatSchema.includes('drop policy if exists "Public can read approved chat messages"') && !chatSchema.includes('create policy "Public can read approved chat messages"'), "Direct public approved-message table reads must be removed so visitors cannot bypass the join cutoff.");
assert(chatSchema.includes("create table if not exists public.chat_message_moderation_audit") && chatSchema.includes("create or replace function public.moderate_chat_message"), "Chat schema must provide audited manual moderation.");
assert(chatSchema.includes("published_at timestamptz") && chatSchema.includes("chat_messages_published_at_status_check") && chatSchema.includes("set_chat_message_publication_fields"), "Chat schema must separate submission created_at from public published_at.");
assert(chatSchema.includes("when chat_messages.participant_id = p_participant_id then chat_messages.created_at") && chatSchema.includes("else chat_messages.published_at"), "Sender-visible chat ordering must keep own messages in created_at position and order other approved messages by published_at.");
assert(chatSchema.includes("published_at = case when p_next_status = 'approved' then v_now else null end") && chatSchema.includes("approved_at = case when p_next_status = 'approved' then v_now"), "Manual approval must assign approved_at and published_at from the same trusted database timestamp.");
assert(chatSchema.includes("risk_level text") && chatSchema.includes("risk_score integer") && chatSchema.includes("risk_flags text[]") && chatSchema.includes("auto_publish_eligible boolean"), "Chat schema must store deterministic risk classification metadata.");
assert(chatSchema.includes("create or replace function public.classify_chat_message") && chatSchema.includes("chat_message_risk_classifier_version") && chatSchema.includes("artist-live-v3"), "Chat schema must include the artist-live-v3 deterministic chat risk classifier.");
assert(chatSchema.includes("classification := public.classify_chat_message") && chatSchema.includes("then 'queued'") && chatSchema.includes("then 'rejected'"), "Visitor submit RPC must classify accepted messages, queue low-risk messages, and auto-reject only high-risk messages.");
assert(chatSchema.includes("'message_classified'") && chatSchema.includes("'message_auto_rejected'"), "Chat moderation audit must record classification and automatic rule rejections.");
assert(chatSchema.includes("create table if not exists public.event_chat_participants") && chatSchema.includes("event_chat_participants_event_normalized_name_idx"), "Chat schema must enforce event-scoped temporary username uniqueness.");
assert(chatSchema.includes("session_id uuid") && chatSchema.includes("event_chat_participants_event_session_idx"), "Chat schema must preserve generated chat identity by event and session.");
assert(chatSchema.includes("create or replace function public.join_event_chat"), "Chat schema must generate anonymous event identities server-side.");
assert(chatSchema.includes("joined_at,\n            last_seen_at") && chatSchema.includes("inserted_participant.joined_at"), "Join RPC must return the trusted joined_at cutoff and preserve it for existing sessions.");
assert(chatSchema.includes("drop function if exists public.chat_generated_first_names()") && !chatSchema.includes("create or replace function public.chat_generated_first_names"), "Chat schema must remove, not recreate, the obsolete synthetic generated-name helper.");
assert(chatSchema.includes("from public.pick_chat_base_name(event_artist_name) picked") && chatSchema.includes("for suffix_number in 1..50"), "Chat schema must use the curated name pool with sequential event-level suffixes.");
assert(chatSchema.includes("should_reassign_existing") && chatSchema.includes("regexp_replace(existing_participant.display_name"), "Chat schema must repair existing synthetic participant names on the next join.");
assert(chatSchema.includes("revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated"), "Participant identity rows must not be directly enumerable by public clients.");
assert(chatSchema.includes("returns table") && !chatSchema.includes("p_avatar_id text") && !chatSchema.includes("avatar :="), "Generated identity RPC must return only identity fields and must not accept or assign avatars.");
assert(chatSchema.includes("revoke insert on public.chat_messages from anon"), "Anonymous visitors must not rely on fragile direct table inserts.");
assert(chatSchema.includes("returns jsonb") && chatSchema.includes("MESSAGE_RATE_LIMITED") && chatSchema.includes("retryAfterSeconds"), "Visitor submit RPC must return structured JSON errors including rate-limit metadata.");
assert(chatSchema.includes("event_chat_participants.session_id = p_session_id") && chatSchema.includes("INVALID_PARTICIPANT_SESSION"), "Visitor submit RPC must verify participant ownership against the event-scoped session id.");
assert(chatSchema.includes("grant execute on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) to anon, authenticated") && chatSchema.includes("drop function if exists public.submit_chat_message(uuid, uuid, text, uuid)"), "Only the session-verified visitor submit RPC signature should exist for public visitors.");
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

const eventReadiness = readFileSync("src/lib/eventReadiness.ts", "utf8");
assert(eventReadiness.includes("validateEventReadiness") && eventReadiness.includes("Upload a song file before starting the event") && eventReadiness.includes("Upload an artist image before starting the event"), "Shared event readiness validator must require persisted song and artist image fields.");
assert(eventReadiness.includes("Add a merch link or remove the merch image") && eventReadiness.includes("Add a merch image or remove the merch link") && eventReadiness.includes("isValidHttpsUrl"), "Shared event readiness validator must enforce merch image/link pairing and HTTPS merch links.");

const eventService = readFileSync("src/services/eventService.ts", "utf8");
assert(!eventService.includes("shiftWindowToNow"), "Start Event must not shift the explicit event window to now.");
assert(!eventService.includes("scheduleEvent"), "Separate Schedule Event workflow must be removed.");
assert(!eventService.includes("calculateEndsAt"), "Event service must not recalculate ends_at from duration.");
assert(eventService.includes("assertEventReadyToStart") && eventService.includes('input.status === "upcoming" || input.status === "live"'), "Event service must validate readiness before public status updates.");
assert(eventService.includes('.not("artist_image_path", "is", null)') && eventService.includes('.not("artist_name", "is", null)'), "Public event selection must defensively require complete artist metadata.");
assert(!eventService.includes('.not("title", "is", null)'), "Event title must not be required for public event selection.");

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
assert(adminPage.includes("validateEventReadiness") && adminPage.includes("Required to start the event."), "Admin Start Event must show field-level readiness validation.");
assert(adminPage.includes("fieldErrors.merchImage") && adminPage.includes("fieldErrors.merchUrl"), "Admin must render merch image/link field errors before starting.");
assert(!adminPage.includes("Upload artwork or an artist image before starting"), "Artist image must be required directly; artwork must not satisfy the artist image requirement.");
assert(!adminPage.includes('label="Event Title" requiredNote='), "Admin Event Title field must not be marked required to start.");
assert(adminPage.includes("const savedDraft = await updateEvent(baseEvent.id, updates)") && adminPage.includes("const started = await startEvent(savedDraft.id)"), "Start Event must save media paths before publishing the event.");
assert(adminPage.includes("clearConfirmedPendingFiles(uploadedKeys)") && !adminPage.includes("nextFiles.audio = null"), "Pending files must only clear after Supabase returns the confirmed saved row.");
assert(adminPage.includes("MEDIA_PATH_FIELDS.filter(field => latest[field])"), "Admin diagnostics must log which media keys are included in update payloads.");

const migrationSql = readFileSync("supabase/event-end-times-migration.sql", "utf8");
assert(migrationSql.includes("duration_hours::double precision * interval '1 hour'"), "Migration must backfill ends_at from fractional duration hours.");
assert(migrationSql.includes("events_end_after_start"), "Migration must enforce end time after start time.");

const readinessMigration = readFileSync("supabase/event-readiness-public-status.sql", "utf8");
assert(readinessMigration.includes("validate_event_public_readiness") && readinessMigration.includes("new.status not in ('upcoming', 'live', 'finished')"), "Database must reject incomplete public event statuses.");
assert(readinessMigration.includes("artist_image_path") && readinessMigration.includes("EVENT_NOT_READY"), "Database readiness guard must require artist image and return a stable readiness error.");
assert(readinessMigration.includes("Add a merch link or remove the merch image") && readinessMigration.includes("Add a merch image or remove the merch link") && readinessMigration.includes("^https://"), "Database readiness guard must enforce merch image/link pairing and HTTPS merch links.");
assert(!readinessMigration.includes("Add an event title before starting the event") && !readinessMigration.includes("missing_fields := array_append(missing_fields, 'title')"), "Database readiness guard must not require event title.");

const riskMigration = readFileSync("supabase/chat-risk-classification.sql", "utf8");
assert(riskMigration.includes("add column if not exists risk_level") && riskMigration.includes("add column if not exists auto_publish_eligible"), "Risk classification migration must add risk metadata fields.");
assert(riskMigration.includes("create or replace function public.classify_chat_message") && riskMigration.includes("CONTAINS_LINK") && riskMigration.includes("SCRIPT_PAYLOAD") && riskMigration.includes("artist-live-v3"), "Risk classification migration must install the artist-live-v3 rule priority classifier.");
assert(!riskMigration.includes("array_append(flags, 'PERSONAL_ATTACK')") && !riskMigration.includes("array_append(flags, 'HARASSMENT')") && !riskMigration.includes("RECENT_DUPLICATE") && !riskMigration.includes("REPEATED_DUPLICATE"), "Artist-live-v3 must not escalate targeted insults, harassment, or duplicate-looking fan style.");
assert(riskMigration.includes("'SCAM'") && riskMigration.includes("crypto giveaway") && riskMigration.includes("ADMIN_IMPERSONATION") && riskMigration.includes("force_high := true"), "Risk classifier must force high for scams and impersonation.");
assert(riskMigration.includes("SOCIAL_PROMOTION") && riskMigration.includes("FOLLOW_SOLICITATION") && riskMigration.includes("CONTACT_SOLICITATION") && riskMigration.includes("SOCIAL_HANDLE"), "Risk classification migration must include social promotion and contact-solicitation flags.");
assert(riskMigration.includes("music|social") && riskMigration.includes("([/:?#][^[:space:]]*)?"), "Risk classification migration must detect bare domains with subdomains, paths, query strings, and fragments.");
assert(!riskMigration.includes("follow|dm|message|contact|add|subscribe|join|check|profile|account|insta|instagram|ig") && riskMigration.includes("message me|message me on") && riskMigration.includes("(^|[^a-z0-9])(instagram|insta|ig"), "Social handle rules must avoid broad false positives such as ordinary @mentions or 'big @username'.");
assert(!riskMigration.includes("REPEATED_CHARACTERS") && !riskMigration.includes("EXCESSIVE_PUNCTUATION") && !riskMigration.includes("EXCESSIVE_UPPERCASE") && !riskMigration.includes("LONG_UNBROKEN_TOKEN") && !riskMigration.includes("EXCESSIVE_MENTIONS") && !riskMigration.includes("SUSPICIOUS_INVISIBLE_CHARACTERS") && !riskMigration.includes("HTML_MARKUP") && !riskMigration.includes("position(U&'\\200D'"), "Risk classifier must keep repetition, punctuation, caps, keyboard-smashes, emoji composition, and style-only text low.");
assert(riskMigration.includes("chat_message_public_submission_payload") && riskMigration.includes("event_chat_participants.session_id = p_session_id") && !riskMigration.includes("to_jsonb(inserted_message)"), "Risk migration submit RPC must verify session ownership and return allowlisted payloads.");
assert(riskMigration.includes("drop function if exists public.submit_chat_message(uuid, uuid, text, uuid)") && riskMigration.includes("grant execute on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) to anon, authenticated"), "Risk migration must drop the obsolete four-argument submit RPC and expose only the session-verified signature.");
assert(riskMigration.includes("match_mode in ('exact', 'substring', 'word')") && riskMigration.includes("term_record.match_mode = 'word'"), "Risk terms must support whole-word profanity matching.");
assert(!riskMigration.includes("[[:alpha:]]+ is terrible") && !riskMigration.includes("[[:alpha:]]+ is trash"), "Targeted harassment rules must not classify generic content criticism as person-directed abuse.");
assert(riskMigration.includes("risk_level = 'medium'") && riskMigration.includes("CLASSIFIER_FAILURE") && riskMigration.includes("auto_publish_eligible = false"), "Classifier failures must remain private and ineligible.");
assert(!riskMigration.includes("status = case when classification->>'riskLevel' = 'low' then 'approved'") && !riskMigration.includes("published_at = clock_timestamp()"), "Step 4 must not automatically approve or publish classified messages.");

const artistLiveV3Migration = readFileSync("supabase/chat-artist-live-v3-classifier.sql", "utf8");
assert(artistLiveV3Migration.includes("select 'artist-live-v3'") && artistLiveV3Migration.includes("create or replace function public.classify_chat_message"), "Artist-live-v3 migration must update the active classifier version and classifier function.");
assert(artistLiveV3Migration.includes("if force_high then") && artistLiveV3Migration.includes("elsif score >= 20 then") && artistLiveV3Migration.includes("else\n    risk_level := 'low'"), "Artist-live-v3 must use explicit high, then link/promotion medium, else low priority.");
assert(!artistLiveV3Migration.includes("array_append(flags, 'PERSONAL_ATTACK')") && !artistLiveV3Migration.includes("array_append(flags, 'HARASSMENT')") && !artistLiveV3Migration.includes("array_append(flags, 'REPEATED_CHARACTERS')") && !artistLiveV3Migration.includes("array_append(flags, 'EXCESSIVE_UPPERCASE')") && !artistLiveV3Migration.includes("array_append(flags, 'EXCESSIVE_PUNCTUATION')"), "Artist-live-v3 must not attach active style, personal-attack, or harassment flags.");
assert(artistLiveV3Migration.includes("'CONTAINS_LINK'") && artistLiveV3Migration.includes("'SOCIAL_PROMOTION'") && artistLiveV3Migration.includes("'FOLLOW_SOLICITATION'") && artistLiveV3Migration.includes("'CONTACT_SOLICITATION'") && artistLiveV3Migration.includes("'SOCIAL_HANDLE'"), "Artist-live-v3 must keep links and promotional/contact solicitation as medium-risk disqualifiers.");
assert(artistLiveV3Migration.includes("'THREAT'") && artistLiveV3Migration.includes("'UNSAFE_PROTOCOL'") && artistLiveV3Migration.includes("'SCRIPT_PAYLOAD'") && artistLiveV3Migration.includes("'SCAM'") && artistLiveV3Migration.includes("'ADMIN_IMPERSONATION'"), "Artist-live-v3 must keep threats, malicious payloads, scams, and impersonation high-risk.");
assert(artistLiveV3Migration.includes("artist_live_v3_classifier_repair") && artistLiveV3Migration.includes("'PERSONAL_ATTACK'") && artistLiveV3Migration.includes("'HARASSMENT'") && artistLiveV3Migration.includes("'REPEATED_CHARACTERS'"), "Artist-live-v3 migration must reclassify existing non-public rows carrying old style or insult flags.");
assert(!artistLiveV3Migration.includes("'PERSONAL_ATTACK',\n        'HARASSMENT',\n        'CLASSIFIER_FAILURE'"), "Artist-live-v3 queue eligibility must not disqualify personal attack or harassment flags.");

const queueMigration = readFileSync("supabase/chat-auto-publish-queue.sql", "utf8");
assert(queueMigration.includes("status in ('pending', 'queued', 'approved', 'rejected')") && queueMigration.includes("queued_at timestamptz") && queueMigration.includes("queue_attempt_count integer"), "Auto-publish queue migration must add queued status and queue metadata.");
assert(queueMigration.includes("when classification->>'riskLevel' = 'low'") && queueMigration.includes("then 'queued'") && queueMigration.includes("'message_queued'"), "Low-risk eligible visitor messages must enter the durable queue.");
assert(queueMigration.includes("create or replace function public.process_chat_auto_publish_queue") && queueMigration.includes("pg_try_advisory_xact_lock") && queueMigration.includes("approval_source = 'queue'"), "Queue worker must use event-scoped locking and queue approval metadata.");
assert(queueMigration.includes("next_auto_publish_at = v_now + interval '3 seconds'") && queueMigration.includes("create or replace function public.process_chat_publish_queue") && queueMigration.includes("'process-chat-publish-queue'") && queueMigration.includes("'3 seconds'"), "Step 5 queue worker must use one global three-second chat publish schedule plus event-level timing.");
assert(queueMigration.includes("where jobname in (") && queueMigration.includes("'process-chat-publish-queue-2'") && queueMigration.includes("perform cron.unschedule(obsolete_job.jobid)"), "Queue migration must remove only known obsolete duplicate chat queue jobs before creating the single intended job.");
assert(!queueMigration.includes("perform pg_sleep(3)") && !queueMigration.includes("create or replace function public.run_chat_auto_publish_queue_for_minute") && !queueMigration.includes("select public.run_chat_auto_publish_queue_for_minute") && !queueMigration.includes("'2 seconds'") && !queueMigration.includes("'4 seconds'") && !queueMigration.includes("'5 seconds'"), "Queue migration must not use minute-loop workarounds or multiple second-value schedules.");
assert(queueMigration.includes("auto_publish_enabled boolean not null default false") && queueMigration.includes("queue_paused boolean not null default false") && queueMigration.includes("set_event_chat_auto_publish_settings"), "Events must expose controlled auto-publish and pause settings.");
assert(queueMigration.includes("order by chat_messages.queue_priority desc, chat_messages.queued_at asc, chat_messages.id asc"), "Step 5 queue selection must remain FIFO by priority and queued time.");
assert(!queueMigration.includes("random()") && !queueMigration.includes("sample") && !queueMigration.includes("burst"), "Step 5 must not implement randomized timing, sampling, or bursts.");
assert(queueMigration.includes("alter table public.chat_message_moderation_audit enable row level security") && queueMigration.includes("revoke all on table public.chat_message_moderation_audit from anon, authenticated") && queueMigration.includes("events.owner_id = auth.uid()"), "Queue migration must explicitly protect moderation audit rows and allow event-owner reads only.");
assert(queueMigration.includes("grant select on table public.chat_message_moderation_audit to authenticated"), "Queue migration must grant authenticated users SELECT on audit rows so RLS can filter owner-scoped reads.");
assert(queueMigration.includes("alter table public.chat_risk_terms enable row level security") && queueMigration.includes("revoke select, insert, update, delete, truncate on table public.chat_risk_terms from anon, authenticated"), "Queue migration must protect risk terms from public reads and mutations.");
assert(queueMigration.includes("revoke all on function public.process_chat_auto_publish_queue(uuid) from anon, authenticated") && queueMigration.includes("revoke all on function public.process_chat_publish_queue(uuid) from anon, authenticated"), "Queue worker functions must not be executable by normal signed-in users.");
assert(queueMigration.includes("revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from public") && queueMigration.includes("revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from anon, authenticated"), "Queue eligibility helper must remain internal-only.");
assert(!queueMigration.includes("grant execute on function public.process_chat_auto_publish_queue(uuid) to authenticated") && !queueMigration.includes("grant execute on function public.process_chat_publish_queue(uuid) to authenticated"), "Queue worker execute grants to authenticated must not return.");
assert(queueMigration.includes("chat_message_public_submission_payload") && queueMigration.includes("event_chat_participants.session_id = p_session_id") && !queueMigration.includes("to_jsonb(inserted_message)") && !queueMigration.includes("to_jsonb(existing_message)"), "Queue migration visitor submit RPC must verify session ownership and return only allowlisted message fields.");
assert(queueMigration.includes("grant execute on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) to anon, authenticated") && queueMigration.includes("drop function if exists public.submit_chat_message(uuid, uuid, text, uuid)"), "Visitor submit RPC must remain only on the session-verified signature.");

const naturalTimingMigration = readFileSync("supabase/chat-natural-publication-timing.sql", "utf8");
assert(naturalTimingMigration.includes("scheduler_version = 'natural-v1'") && naturalTimingMigration.includes("current_queue_band") && naturalTimingMigration.includes("last_calculated_delay_ms"), "Natural timing migration must persist scheduler diagnostics on events.");
assert(naturalTimingMigration.includes("get_chat_publish_timing_band") && naturalTimingMigration.includes("1800, 4500") && naturalTimingMigration.includes("1000, 3200") && naturalTimingMigration.includes("500, 1800") && naturalTimingMigration.includes("350, 1400"), "Natural timing migration must define the requested queue-size delay bands.");
assert(naturalTimingMigration.includes("calculate_chat_publish_delay_ms") && naturalTimingMigration.includes("(random() + random() + random()) / 3.0"), "Natural timing migration must use a weighted random delay distribution rather than uniform single random selection.");
assert(naturalTimingMigration.includes("publication_budget_per_minute") && naturalTimingMigration.includes("90") && naturalTimingMigration.includes("queue_budget_throttled"), "Natural timing migration must enforce rolling publication budgets with a 90/minute hard cap band.");
assert(naturalTimingMigration.includes("queue_burst_released") && naturalTimingMigration.includes("release_size := 2") && naturalTimingMigration.includes("150 + floor(random() * 451)") && naturalTimingMigration.includes("participant_id is distinct from first_message.participant_id"), "Natural timing migration must implement controlled two-message bursts with different participants and 150-600ms spacing.");
assert(naturalTimingMigration.includes("order by chat_messages.queue_priority desc, chat_messages.queued_at asc, chat_messages.id asc") && naturalTimingMigration.includes("pg_try_advisory_xact_lock"), "Natural timing migration must preserve FIFO queue selection and event-specific locking.");
assert(naturalTimingMigration.includes("'process-chat-publish-queue'") && naturalTimingMigration.includes("'3 seconds'") && !naturalTimingMigration.includes("'2 seconds'") && !naturalTimingMigration.includes("'4 seconds'") && !naturalTimingMigration.includes("'5 seconds'"), "Natural timing migration must preserve exactly one global three-second cron heartbeat.");
assert(naturalTimingMigration.includes("revoke all on function public.process_chat_auto_publish_queue(uuid) from anon, authenticated") && naturalTimingMigration.includes("revoke all on function public.process_chat_publish_queue(uuid) from anon, authenticated"), "Natural timing worker functions must remain unavailable to visitor roles.");
assert(naturalTimingMigration.includes("public.is_chat_message_auto_publish_eligible") && !naturalTimingMigration.includes("create or replace function public.classify_chat_message"), "Natural timing migration must preserve queue eligibility checks without changing classifier rules.");

const linkPromotionMigration = readFileSync("supabase/chat-link-promotion-safety.sql", "utf8");
assert(linkPromotionMigration.includes("create or replace function public.classify_chat_message") && linkPromotionMigration.includes("CONTAINS_LINK") && linkPromotionMigration.includes("music|social"), "Link-promotion safety migration must install the updated bare-domain classifier.");
assert(linkPromotionMigration.includes("SOCIAL_PROMOTION") && linkPromotionMigration.includes("FOLLOW_SOLICITATION") && linkPromotionMigration.includes("CONTACT_SOLICITATION") && linkPromotionMigration.includes("SOCIAL_HANDLE"), "Link-promotion safety migration must classify social promotion and contact solicitation.");
assert(linkPromotionMigration.includes("create or replace function public.is_chat_message_auto_publish_eligible") && linkPromotionMigration.includes("'CONTAINS_LINK'") && linkPromotionMigration.includes("'SOCIAL_PROMOTION'") && linkPromotionMigration.includes("'CLASSIFIER_FAILURE'"), "Auto-publish eligibility must centrally disqualify links, promotion, unsafe protocols, and classifier failures.");
assert(linkPromotionMigration.includes("queue_eligibility_revoked") && linkPromotionMigration.includes("link_social_promotion_safety_repair"), "Migration must revoke stale queued link/social-promotion messages and audit the repair.");
assert(linkPromotionMigration.includes("where jobname in (") && linkPromotionMigration.includes("'process-chat-publish-queue-2'") && linkPromotionMigration.includes("'3 seconds'"), "Link-promotion safety migration must preserve the single global three-second queue worker schedule cleanup.");
assert(!linkPromotionMigration.includes("'2 seconds'") && !linkPromotionMigration.includes("'4 seconds'") && !linkPromotionMigration.includes("'5 seconds'"), "Link-promotion safety migration must not recreate multiple second-value queue schedules.");
assert(linkPromotionMigration.includes("alter table public.chat_message_moderation_audit enable row level security") && linkPromotionMigration.includes("revoke all on table public.chat_message_moderation_audit from anon, authenticated") && linkPromotionMigration.includes("events.owner_id = auth.uid()"), "Link-promotion safety migration must explicitly protect moderation audit rows and allow event-owner reads only.");
assert(linkPromotionMigration.includes("grant select on table public.chat_message_moderation_audit to authenticated"), "Link-promotion safety migration must grant authenticated users SELECT on audit rows so RLS can filter owner-scoped reads.");
assert(linkPromotionMigration.includes("alter table public.chat_risk_terms enable row level security") && linkPromotionMigration.includes("revoke select, insert, update, delete, truncate on table public.chat_risk_terms from anon, authenticated"), "Link-promotion safety migration must protect risk terms from public reads and mutations.");
assert(linkPromotionMigration.includes("revoke all on function public.process_chat_auto_publish_queue(uuid) from anon, authenticated") && linkPromotionMigration.includes("revoke all on function public.process_chat_publish_queue(uuid) from anon, authenticated"), "Link-promotion safety migration must revoke worker function execution from normal users.");
assert(linkPromotionMigration.includes("revoke all on function public.classify_chat_message(uuid, uuid, uuid, text) from public, anon, authenticated"), "Link-promotion safety migration must revoke direct classifier execution from application roles.");
assert(linkPromotionMigration.includes("revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from public") && linkPromotionMigration.includes("revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from anon, authenticated"), "Link-promotion safety migration must keep the queue eligibility helper internal-only.");
assert(!linkPromotionMigration.includes("grant execute on function public.process_chat_auto_publish_queue(uuid) to authenticated") && !linkPromotionMigration.includes("grant execute on function public.process_chat_publish_queue(uuid) to authenticated"), "Link-promotion safety migration must not grant queue worker execution to authenticated.");
assert(linkPromotionMigration.includes("chat_message_public_submission_payload") && linkPromotionMigration.includes("event_chat_participants.session_id = p_session_id") && !linkPromotionMigration.includes("to_jsonb(inserted_message)") && !linkPromotionMigration.includes("to_jsonb(existing_message)"), "Link-promotion safety migration visitor submit RPC must verify session ownership and return only allowlisted message fields.");
assert(linkPromotionMigration.includes("grant execute on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) to anon, authenticated") && linkPromotionMigration.includes("drop function if exists public.submit_chat_message(uuid, uuid, text, uuid)"), "Link-promotion safety migration must remove the obsolete four-argument submit RPC and preserve visitor submit access only on the session-verified signature.");
assert(!linkPromotionMigration.includes("(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb).*@[a-z0-9]"), "Historical repair must not use the old broad platform-plus-handle regex that can catch normal text.");
assert(!linkPromotionMigration.includes("array_append(flags, 'PERSONAL_ATTACK')") && !linkPromotionMigration.includes("array_append(flags, 'HARASSMENT')") && !linkPromotionMigration.includes("array_append(flags, 'REPEATED_CHARACTERS')") && !linkPromotionMigration.includes("array_append(flags, 'EXCESSIVE_PUNCTUATION')") && !linkPromotionMigration.includes("array_append(flags, 'EXCESSIVE_UPPERCASE')") && !linkPromotionMigration.includes("position(U&'\\200D'"), "Link-promotion safety migration must preserve insults, fan excitement, and emoji composition as low-risk behavior.");
assert(linkPromotionMigration.includes("fan_excitation_classifier_repair") && linkPromotionMigration.includes("'PROFANITY'") && linkPromotionMigration.includes("'REPEATED_CHARACTERS'") && linkPromotionMigration.includes("'SUSPICIOUS_INVISIBLE_CHARACTERS'"), "Link-promotion safety migration must reclassify old non-public profanity-only, repeated-character, and emoji-invisible false positives.");
assert(linkPromotionMigration.includes("with candidates as") && linkPromotionMigration.includes("public.classify_chat_message(candidates.event_id, candidates.participant_id, candidates.id, candidates.body)") && linkPromotionMigration.includes("decisions.next_queue_eligible"), "Historical repair must re-run the authoritative classifier and derive queue eligibility instead of forcing every candidate pending.");
assert(linkPromotionMigration.includes("when decisions.status = 'queued' and decisions.next_queue_eligible then 'queued'") && linkPromotionMigration.includes("where not exists (") && linkPromotionMigration.includes("link_social_promotion_safety_repair"), "Historical repair must preserve valid queued rows and write idempotent repair audit entries.");

const listenerCutoffMigration = readFileSync("supabase/chat-listener-count-and-join-cutoff.sql", "utf8");
const publicPinnedMigration = readFileSync("supabase/chat-public-pinned-message-area.sql", "utf8");
const visitorDeltaMigration = readFileSync("supabase/chat-visitor-message-delta.sql", "utf8");
assert(listenerCutoffMigration.includes("add column if not exists joined_at") && listenerCutoffMigration.includes("set joined_at = created_at"), "Listener/cutoff migration must add joined_at and backfill it from participant creation time.");
assert(listenerCutoffMigration.includes("create unique index if not exists event_chat_participants_event_session_idx") && listenerCutoffMigration.includes("on public.event_chat_participants(event_id, session_id)"), "Listener/cutoff migration must preserve one participant per event/session.");
assert(listenerCutoffMigration.includes("create or replace function public.get_event_listener_count") && listenerCutoffMigration.includes("count(*)::integer"), "Listener/cutoff migration must provide the controlled cumulative listener-count RPC.");
assert(listenerCutoffMigration.includes("returns table") && listenerCutoffMigration.includes("published_at >= verified_participant.joined_at") && listenerCutoffMigration.includes("or chat_messages.participant_id = p_participant_id"), "Listener/cutoff migration must enforce the published_at join cutoff while preserving own sender-private messages.");
assert(listenerCutoffMigration.includes("joined_at timestamptz") && listenerCutoffMigration.includes("existing_participant.joined_at") && listenerCutoffMigration.includes("inserted_participant.joined_at"), "Listener/cutoff migration must return and preserve joined_at from join_event_chat.");
assert(listenerCutoffMigration.includes('drop policy if exists "Public can read approved chat messages"') && listenerCutoffMigration.includes("revoke select on public.chat_messages from anon"), "Listener/cutoff migration must remove direct anonymous approved-message reads.");
assert(publicPinnedMigration.includes("or chat_messages.is_pinned = true") && publicPinnedMigration.includes("chat_messages.status = 'approved'") && publicPinnedMigration.includes("published_at >= verified_participant.joined_at"), "Pinned-message migration must expose the current approved pin without reopening pre-join message history.");
assert(chatSchema.includes("or chat_messages.is_pinned = true") && chatSchema.includes("chat_messages_one_pinned_per_event_idx"), "Canonical chat schema must include the active-pin cutoff exception and one-pin-per-event protection.");
assert(visitorDeltaMigration.includes("create or replace function public.get_visitor_visible_chat_message_delta") && visitorDeltaMigration.includes("public_new_delta as") && visitorDeltaMigration.includes("published_at >= verified_participant.joined_at") && visitorDeltaMigration.includes("published_at <= request.snapshot_at"), "Visitor delta migration must preserve the joined_at cutoff and database snapshot boundary.");
assert(visitorDeltaMigration.includes("chat_messages.published_at > p_after_published_at") && visitorDeltaMigration.includes("chat_messages.id > p_after_id") && visitorDeltaMigration.includes("p_after_public_updated_at") && visitorDeltaMigration.includes("p_after_private_updated_at"), "Visitor delta migration must use tuple public cursors and separate public/private update cursors.");

const cronSql = readFileSync("supabase/event-status-cron.sql", "utf8");
assert(cronSql.includes("status = 'upcoming'") && cronSql.includes("starts_at <= now()"), "Cron must promote due upcoming events to live.");
assert(cronSql.includes("status in ('upcoming', 'live')") && cronSql.includes("ends_at <= now()"), "Cron must finish expired upcoming/live events.");
assert(cronSql.includes("'* * * * *'"), "Cron should run once per minute.");

console.log("event timing checks passed");
