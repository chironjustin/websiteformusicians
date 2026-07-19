-- Artist live-chat classifier v3.
-- Policy: HIGH for clear dangerous/malicious content, MEDIUM for links or
-- promotion/contact solicitation, LOW for everything else.

create or replace function public.chat_message_risk_classifier_version()
returns text
language sql
immutable
as $$
  select 'artist-live-v3';
$$;

create or replace function public.classify_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_message_id uuid,
  p_body text
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  clean_body text := coalesce(p_body, '');
  comparison_body text := public.normalize_chat_body_for_risk(p_body);
  score integer := 0;
  flags text[] := array[]::text[];
  force_high boolean := false;
  mention_count integer := 0;
  term_record record;
  risk_level text;
begin
  mention_count := length(clean_body) - length(replace(clean_body, '@', ''));

  if clean_body ~* '(javascript|data|file)\s*:' then
    flags := array_append(flags, 'UNSAFE_PROTOCOL');
    force_high := true;
  end if;

  if clean_body ~* '(https?://|www\.)'
    or comparison_body ~ '(^|[^[:alnum:]_@-])([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(com|org|net|edu|gov|io|co|uk|de|fr|it|es|nl|be|ch|at|se|no|dk|fi|pl|cz|ca|us|au|nz|jp|kr|cn|in|br|mx|tv|fm|me|app|dev|gg|ly|cloud|info|biz|xyz|shop|store|music|social)([/:?#][^[:space:]]*)?([^[:alnum:]_]|$)' then
    flags := array_append(flags, 'CONTAINS_LINK');
    score := 25;
  end if;

  if comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|check my page|check my profile|check out my account|check my account)' then
    flags := array_append(flags, 'FOLLOW_SOLICITATION');
    score := 25;
  end if;

  if comparison_body ~ '(dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|join the discord|my insta is|my instagram is|my ig is|my snap is|my snapchat is|my telegram is)' then
    flags := array_append(flags, 'CONTACT_SOLICITATION');
    score := 25;
  end if;

  if comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|check my page|check my profile|check out my account|check my account|my (insta|instagram|ig|snap|snapchat|telegram) is)'
    and comparison_body ~ '(^|[^a-z0-9])(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb)([^a-z0-9]|$)|@[a-z0-9]' then
    flags := array_append(flags, 'SOCIAL_PROMOTION');
    score := 25;
  end if;

  if comparison_body ~ '(^|[[:space:][:punct:]])@[a-z0-9][a-z0-9._]{1,28}[a-z0-9]([^a-z0-9._]|$)'
    and (
      comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|check my page|check my profile|check out my account|check my account|my insta is|my instagram is|my ig is|my snap is|my snapchat is|my telegram is)'
      or comparison_body ~ '(^|[^a-z0-9])(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb)([^a-z0-9]|$)'
    ) then
    flags := array_append(flags, 'SOCIAL_HANDLE');
    score := 25;
  end if;

  if clean_body ~* '([a-z0-9-]+\s*(\[dot\]|\(dot\)| dot )\s*[a-z]{2,})' then
    flags := array_append(flags, 'OBFUSCATED_LINK');
    score := 25;
  end if;

  if clean_body ~* '(<\s*script|<\s*iframe|onerror\s*=|onclick\s*=|javascript\s*:)' then
    flags := array_append(flags, 'SCRIPT_PAYLOAD');
    force_high := true;
  end if;

  if position(U&'\202A' in clean_body) > 0
    or position(U&'\202B' in clean_body) > 0
    or position(U&'\202D' in clean_body) > 0
    or position(U&'\202E' in clean_body) > 0
    or position(U&'\2066' in clean_body) > 0
    or position(U&'\2067' in clean_body) > 0
    or position(U&'\2068' in clean_body) > 0 then
    flags := array_append(flags, 'BIDI_CONTROL_ABUSE');
    force_high := true;
  end if;

  if comparison_body ~ '(kill yourself|go die|i hope you die|i(''m| am|m) going to kill you)' then
    flags := array_append(flags, 'THREAT');
    force_high := true;
  end if;

  if comparison_body ~ '(i am|i''m|im)\s+(the\s+)?official\s+artist'
    or comparison_body ~ 'official\s+artist\s+announcement' then
    flags := array_append(flags, 'ARTIST_IMPERSONATION');
    force_high := true;
  elsif comparison_body ~ '(i am|i''m|im)\s+(an?\s+)?(admin|moderator)'
    or comparison_body ~ 'official\s+admin\s+announcement' then
    flags := array_append(flags, 'ADMIN_IMPERSONATION');
    force_high := true;
  end if;

  if comparison_body ~ '(crypto giveaway|free crypto|send (crypto|bitcoin|btc|ethereum|eth)|seed phrase|wallet seed|double your money|airdrop claim|claim your airdrop)' then
    flags := array_append(flags, 'SCAM');
    force_high := true;
  end if;

  for term_record in
    select *
    from public.chat_risk_terms
    where is_active = true
  loop
    if (
      term_record.match_mode = 'exact'
      and comparison_body = term_record.normalized_term
    ) or (
      term_record.match_mode = 'substring'
      and position(term_record.normalized_term in comparison_body) > 0
    ) or (
      term_record.match_mode = 'word'
      and comparison_body ~ ('(^|[^[:alnum:]_])' || term_record.normalized_term || '([^[:alnum:]_]|$)')
    ) then
      flags := array_append(flags, term_record.flag);
      if term_record.risk = 'hard'
        or term_record.flag in ('ADMIN_IMPERSONATION', 'ARTIST_IMPERSONATION', 'SCAM') then
        force_high := true;
      elsif term_record.flag in (
        'CONTAINS_LINK',
        'OBFUSCATED_LINK',
        'SOCIAL_PROMOTION',
        'FOLLOW_SOLICITATION',
        'CONTACT_SOLICITATION',
        'SOCIAL_HANDLE'
      ) then
        score := 25;
      end if;
    end if;
  end loop;

  if force_high then
    risk_level := 'high';
    score := 60;
  elsif score >= 20 then
    risk_level := 'medium';
    score := 25;
  else
    risk_level := 'low';
    score := 0;
  end if;

  return jsonb_build_object(
    'riskLevel', risk_level,
    'riskScore', score,
    'riskFlags', coalesce((select array_agg(distinct risk_flag) from unnest(flags) as risk_flag(risk_flag)), array[]::text[]),
    'classifierVersion', public.chat_message_risk_classifier_version(),
    'autoPublishEligible', risk_level = 'low'
  );
end;
$$;

revoke all on function public.classify_chat_message(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.is_chat_message_auto_publish_eligible(p_message public.chat_messages)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    p_message.status = 'queued'
    and p_message.risk_level = 'low'
    and p_message.auto_publish_eligible = true
    and p_message.published_at is null
    and not (
      coalesce(p_message.risk_flags, array[]::text[])
      && array[
        'CONTAINS_LINK',
        'OBFUSCATED_LINK',
        'UNSAFE_PROTOCOL',
        'SOCIAL_PROMOTION',
        'FOLLOW_SOLICITATION',
        'CONTACT_SOLICITATION',
        'SOCIAL_HANDLE',
        'CLASSIFIER_FAILURE'
      ]::text[]
    );
$$;

revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from public;
revoke all on function public.is_chat_message_auto_publish_eligible(public.chat_messages) from anon, authenticated;

with candidates as (
  select chat_messages.*
  from public.chat_messages
  where status in ('pending', 'queued')
    and is_admin = false
    and (
      classifier_version is distinct from public.chat_message_risk_classifier_version()
      or coalesce(risk_flags, array[]::text[]) && array[
        'PROFANITY',
        'PERSONAL_ATTACK',
        'HARASSMENT',
        'REPEATED_CHARACTERS',
        'EXCESSIVE_UPPERCASE',
        'EXCESSIVE_PUNCTUATION',
        'SUSPICIOUS_INVISIBLE_CHARACTERS',
        'HTML_MARKUP',
        'LONG_UNBROKEN_TOKEN',
        'EXCESSIVE_MENTIONS',
        'EXCESSIVE_LINES'
      ]::text[]
    )
), classified as (
  select
    candidates.*,
    classification.result,
    coalesce(ARRAY(SELECT jsonb_array_elements_text(classification.result->'riskFlags')), array[]::text[]) as next_risk_flags,
    classification.result->>'riskLevel' as next_risk_level,
    (classification.result->>'riskScore')::integer as next_risk_score,
    classification.result->>'classifierVersion' as next_classifier_version
  from candidates
  cross join lateral (
    select public.classify_chat_message(candidates.event_id, candidates.participant_id, candidates.id, candidates.body) as result
  ) classification
), decisions as (
  select
    classified.*,
    (
      next_risk_level = 'low'
      and not (
        next_risk_flags && array[
          'CONTAINS_LINK',
          'OBFUSCATED_LINK',
          'UNSAFE_PROTOCOL',
          'SOCIAL_PROMOTION',
          'FOLLOW_SOLICITATION',
          'CONTACT_SOLICITATION',
          'SOCIAL_HANDLE',
          'CLASSIFIER_FAILURE'
        ]::text[]
      )
    ) as next_queue_eligible
  from classified
), reclassified as (
  update public.chat_messages
  set
    risk_level = decisions.next_risk_level,
    risk_score = decisions.next_risk_score,
    risk_flags = decisions.next_risk_flags,
    classified_at = clock_timestamp(),
    classifier_version = decisions.next_classifier_version,
    auto_publish_eligible = decisions.next_queue_eligible,
    status = case
      when decisions.next_risk_level = 'high' then 'rejected'
      when decisions.status = 'queued' and decisions.next_queue_eligible then 'queued'
      else 'pending'
    end,
    queued_at = case
      when decisions.status = 'queued' and decisions.next_queue_eligible then coalesce(decisions.queued_at, clock_timestamp())
      else null
    end,
    published_at = null,
    rejected_at = case when decisions.next_risk_level = 'high' then clock_timestamp() else chat_messages.rejected_at end,
    rejection_source = case when decisions.next_risk_level = 'high' then 'automatic_rules' else chat_messages.rejection_source end,
    rejection_reason = case when decisions.next_risk_level = 'high' then 'automatic_rules' else chat_messages.rejection_reason end,
    last_queue_error = case
      when decisions.status = 'queued' and not decisions.next_queue_eligible then 'queue_eligibility_revoked'
      when decisions.status = 'queued' and decisions.next_queue_eligible then null
      else chat_messages.last_queue_error
    end
  from decisions
  where chat_messages.id = decisions.id
  returning chat_messages.*, decisions.status as previous_status
)
insert into public.chat_message_moderation_audit (
  event_id,
  message_id,
  participant_id,
  actor_id,
  action,
  previous_status,
  new_status,
  reason,
  risk_level,
  risk_flags,
  classifier_version
)
select
  reclassified.event_id,
  reclassified.id,
  reclassified.participant_id,
  null,
  case
    when reclassified.previous_status = 'queued' and reclassified.status <> 'queued' then 'queue_eligibility_revoked'
    else 'message_classified'
  end,
  reclassified.previous_status,
  reclassified.status,
  'artist_live_v3_classifier_repair',
  reclassified.risk_level,
  reclassified.risk_flags,
  reclassified.classifier_version
from reclassified
where not exists (
  select 1
  from public.chat_message_moderation_audit existing_audit
  where existing_audit.message_id = reclassified.id
    and existing_audit.reason = 'artist_live_v3_classifier_repair'
    and existing_audit.previous_status = reclassified.previous_status
    and existing_audit.new_status = reclassified.status
);

notify pgrst, 'reload schema';
