-- Link and social-promotion safety patch for deterministic chat queueing.
-- Run after chat-auto-publish-queue.sql.

alter table public.chat_message_moderation_audit
drop constraint if exists chat_message_moderation_audit_action_check;

alter table public.chat_message_moderation_audit
add constraint chat_message_moderation_audit_action_check
check (
  action in (
    'message_approved',
    'message_rejected',
    'message_classified',
    'message_auto_rejected',
    'message_queued',
    'message_auto_approved',
    'queue_eligibility_revoked',
    'queue_paused',
    'queue_resumed',
    'auto_publish_enabled',
    'auto_publish_disabled'
  )
);

alter table public.chat_message_moderation_audit enable row level security;
revoke all on table public.chat_message_moderation_audit from anon, authenticated;
grant select on table public.chat_message_moderation_audit to authenticated;

drop policy if exists "Owners can read chat moderation audit rows" on public.chat_message_moderation_audit;
create policy "Owners can read chat moderation audit rows"
on public.chat_message_moderation_audit
for select
to authenticated
using (
  exists (
    select 1
    from public.events
    where events.id = chat_message_moderation_audit.event_id
      and events.owner_id = auth.uid()
  )
);

alter table public.chat_risk_terms enable row level security;
revoke select, insert, update, delete, truncate on table public.chat_risk_terms from anon, authenticated;

alter table public.chat_messages
drop constraint if exists chat_messages_queue_state_check;

alter table public.chat_messages
add constraint chat_messages_queue_state_check
check (
  (status = 'queued' and queued_at is not null and published_at is null and risk_level = 'low' and auto_publish_eligible = true)
  or
  (status <> 'queued')
);

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
  duplicate_count integer := 0;
  alpha_count integer := 0;
  upper_count integer := 0;
  mention_count integer := 0;
  term_record record;
  risk_level text;
  event_artist_name text := '';
begin
  select public.normalize_chat_body_for_risk(artist_name)
  into event_artist_name
  from public.events
  where id = p_event_id;

  mention_count := length(clean_body) - length(replace(clean_body, '@', ''));

  if clean_body ~* '(javascript|data|file)\s*:' then
    flags := array_append(flags, 'UNSAFE_PROTOCOL');
    force_high := true;
  end if;

  if clean_body ~* '(https?://|www\.)'
    or comparison_body ~ '(^|[^[:alnum:]_@-])([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(com|org|net|edu|gov|io|co|uk|de|fr|it|es|nl|be|ch|at|se|no|dk|fi|pl|cz|ca|us|au|nz|jp|kr|cn|in|br|mx|tv|fm|me|app|dev|gg|ly|cloud|info|biz|xyz|shop|store|music|social)([/:?#][^[:space:]]*)?([^[:alnum:]_]|$)' then
    flags := array_append(flags, 'CONTAINS_LINK');
    score := score + 25;
  end if;

  if comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|check my page|check my profile|check out my account|check my account)' then
    flags := array_append(flags, 'FOLLOW_SOLICITATION');
    score := score + 25;
  end if;

  if comparison_body ~ '(dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|join the discord|my insta is|my instagram is|my ig is|my snap is|my snapchat is|my telegram is)' then
    flags := array_append(flags, 'CONTACT_SOLICITATION');
    score := score + 25;
  end if;

  if comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|check my page|check my profile|check out my account|check my account|my (insta|instagram|ig|snap|snapchat|telegram) is)'
    and comparison_body ~ '(^|[^a-z0-9])(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb)([^a-z0-9]|$)|@[a-z0-9]' then
    flags := array_append(flags, 'SOCIAL_PROMOTION');
    score := score + 10;
  end if;

  if comparison_body ~ '(^|[[:space:][:punct:]])@[a-z0-9][a-z0-9._]{1,28}[a-z0-9]([^a-z0-9._]|$)'
    and (
      comparison_body ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|check my page|check my profile|check out my account|check my account|my insta is|my instagram is|my ig is|my snap is|my snapchat is|my telegram is)'
      or comparison_body ~ '(^|[^a-z0-9])(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb)([^a-z0-9]|$)'
    ) then
    flags := array_append(flags, 'SOCIAL_HANDLE');
    score := score + 15;
  end if;

  if clean_body ~* '([a-z0-9-]+\s*(\[dot\]|\(dot\)| dot )\s*[a-z]{2,})' then
    flags := array_append(flags, 'OBFUSCATED_LINK');
    score := score + 20;
  end if;

  if clean_body ~* '(<\s*script|<\s*iframe|onerror\s*=|onclick\s*=|javascript\s*:)' then
    flags := array_append(flags, 'SCRIPT_PAYLOAD');
    force_high := true;
  elsif clean_body ~* '<\s*[a-z][^>]*>' then
    flags := array_append(flags, 'HTML_MARKUP');
    score := score + 20;
  end if;

  if (
      position(U&'\200B' in clean_body) > 0
      or position(U&'\FEFF' in clean_body) > 0
    )
    and clean_body ~ '[[:alnum:]]' then
    flags := array_append(flags, 'SUSPICIOUS_INVISIBLE_CHARACTERS');
    score := score + 35;
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

  if (length(clean_body) - length(replace(clean_body, chr(10), ''))) > 8 then
    flags := array_append(flags, 'EXCESSIVE_LINES');
    score := score + 20;
  end if;

  if clean_body ~ '\S{101,}' then
    flags := array_append(flags, 'LONG_UNBROKEN_TOKEN');
    score := score + 20;
  end if;

  mention_count := length(clean_body) - length(replace(clean_body, '@', ''));
  if mention_count > 5 then
    flags := array_append(flags, 'EXCESSIVE_MENTIONS');
    score := score + 15;
  end if;

  alpha_count := char_length(regexp_replace(clean_body, '[^[:alpha:]]', '', 'g'));
  upper_count := char_length(regexp_replace(clean_body, '[^[:upper:]]', '', 'g'));
  if alpha_count >= 20 and upper_count::numeric / greatest(alpha_count, 1) > 0.8 then
    flags := array_append(flags, 'EXCESSIVE_UPPERCASE');
    score := score + 10;
  end if;

  if comparison_body ~ '(kill yourself|go die|i hope you die|i(''m| am|m) going to kill you)' then
    flags := array_append(flags, 'THREAT');
    force_high := true;
  end if;

  if comparison_body ~ '(you suck|you(''re| are|re) (annoying|stupid|an idiot|idiot|trash)|i hate you|nobody likes you|what an idiot)' then
    flags := array_append(flags, 'PERSONAL_ATTACK');
    score := score + 30;
  end if;

  if comparison_body ~ '(this artist sucks|the artist sucks|artist is trash|this artist is trash|worst singer ever|the singer is terrible|singer is terrible|the performer is terrible|performer is trash)'
    or (
      coalesce(event_artist_name, '') <> ''
      and (
        position(event_artist_name || ' sucks' in comparison_body) > 0
        or position(event_artist_name || ' is trash' in comparison_body) > 0
        or position(event_artist_name || ' is terrible' in comparison_body) > 0
      )
    ) then
    flags := array_append(flags, 'HARASSMENT');
    score := score + 30;
  end if;

  if comparison_body ~ '(you suck|you(''re| are|re) (annoying|stupid|an idiot|idiot|trash)|i hate you|nobody likes you)'
    and comparison_body ~ '(fuck|shit|bitch|asshole)' then
    score := score + 15;
  end if;

  if comparison_body ~ '(i am|i''m|im)\s+(the\s+)?official\s+artist'
    or comparison_body ~ 'official\s+artist\s+announcement' then
    flags := array_append(flags, 'ARTIST_IMPERSONATION');
    force_high := true;
  elsif comparison_body ~ '(i am|i''m|im)\s+(an?\s+)?(admin|moderator)'
    or comparison_body ~ 'official\s+admin\s+announcement' then
    flags := array_append(flags, 'ADMIN_IMPERSONATION');
    score := score + 35;
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
      if term_record.risk = 'hard' then
        force_high := true;
      elsif term_record.flag = 'PROFANITY' then
        score := score + 20;
      else
        score := score + 25;
      end if;
    end if;
  end loop;

  select count(*)::integer
  into duplicate_count
  from public.chat_messages
  where event_id = p_event_id
    and participant_id = p_participant_id
    and id <> p_message_id
    and is_admin = false
    and created_at > now() - interval '10 minutes'
    and public.normalize_chat_body_for_risk(body) = comparison_body;

  if duplicate_count >= 2 then
    flags := array_append(flags, 'REPEATED_DUPLICATE');
    force_high := true;
  elsif duplicate_count = 1 then
    flags := array_append(flags, 'RECENT_DUPLICATE');
    score := score + 30;
  end if;

  score := least(score, 100);

  if force_high or score >= 60 then
    risk_level := 'high';
    score := greatest(score, 60);
  elsif score >= 20 then
    risk_level := 'medium';
  else
    risk_level := 'low';
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

create or replace function public.chat_message_public_submission_payload(p_message public.chat_messages)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_message.id,
    'event_id', p_message.event_id,
    'participant_id', p_message.participant_id,
    'display_name', p_message.display_name,
    'body', p_message.body,
    'status', p_message.status,
    'client_token', p_message.client_token,
    'created_at', p_message.created_at,
    'published_at', p_message.published_at
  );
$$;

revoke all on function public.chat_message_public_submission_payload(public.chat_messages) from public, anon, authenticated;

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_session_id uuid,
  p_body text,
  p_client_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_body text;
  participant public.event_chat_participants;
  inserted_message public.chat_messages;
  existing_message public.chat_messages;
  recent_count integer;
  oldest_recent_at timestamptz;
  retry_after_seconds integer;
  classification jsonb;
  v_now timestamptz;
begin
  normalized_body := btrim(coalesce(p_body, ''));

  if p_event_id is null then
    return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_LIVE', 'message', 'Chat is open only during a live event.');
  end if;

  if p_client_token is null then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_ALREADY_SUBMITTED', 'message', 'Message could not be submitted.');
  end if;

  if p_participant_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT', 'message', 'A reserved chat identity is required.');
  end if;

  if p_session_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT_SESSION', 'message', 'Your chat session could not be verified.');
  end if;

  if coalesce(p_body, '') ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_INVALID_CHARACTERS', 'message', 'Message contains unsupported characters.');
  end if;

  if normalized_body = '' then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_EMPTY', 'message', 'Message cannot be empty.');
  end if;

  if char_length(normalized_body) > 400 then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_TOO_LONG', 'message', 'Message must be 400 characters or fewer.');
  end if;

  if not exists (
    select 1
    from public.events
    where events.id = p_event_id
      and events.status in ('upcoming', 'live')
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
  ) then
    return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_LIVE', 'message', 'Chat is open only during a live event.');
  end if;

  select *
  into participant
  from public.event_chat_participants
  where event_chat_participants.id = p_participant_id
    and event_chat_participants.event_id = p_event_id
    and event_chat_participants.session_id = p_session_id;

  if participant.id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT_SESSION', 'message', 'Your chat session could not be verified.');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_participant_id::text));

  select *
  into existing_message
  from public.chat_messages
  where chat_messages.event_id = p_event_id
    and chat_messages.participant_id = p_participant_id
    and chat_messages.client_token = p_client_token
  limit 1;

  if existing_message.id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', public.chat_message_public_submission_payload(existing_message));
  end if;

  select count(*)::integer, min(created_at)
  into recent_count, oldest_recent_at
  from public.chat_messages
  where chat_messages.event_id = p_event_id
    and chat_messages.participant_id = p_participant_id
    and chat_messages.is_admin = false
    and chat_messages.created_at > now() - interval '2 minutes';

  if recent_count >= 3 then
    retry_after_seconds := greatest(
      1,
      ceiling(extract(epoch from ((oldest_recent_at + interval '2 minutes') - now())))::integer
    );

    return jsonb_build_object(
      'ok', false,
      'code', 'MESSAGE_RATE_LIMITED',
      'message', 'Wait a little till sending again.',
      'retryAfterSeconds', retry_after_seconds
    );
  end if;

  begin
    insert into public.chat_messages (
      event_id,
      participant_id,
      user_id,
      display_name,
      body,
      status,
      client_token,
      is_admin,
      is_pinned,
      is_highlighted,
      is_liked,
      auto_publish_eligible,
      risk_flags,
      legacy_assignment_confirmed_at,
      legacy_assignment_confirmed_by
    )
    values (
      p_event_id,
      participant.id,
      null,
      participant.display_name,
      normalized_body,
      'pending',
      p_client_token,
      false,
      false,
      false,
      false,
      false,
      array[]::text[],
      null,
      null
    )
    returning * into inserted_message;
  exception
    when unique_violation then
      select *
      into existing_message
      from public.chat_messages
      where chat_messages.event_id = p_event_id
        and chat_messages.participant_id = p_participant_id
        and chat_messages.client_token = p_client_token
      limit 1;

      if existing_message.id is not null then
        return jsonb_build_object('ok', true, 'duplicate', true, 'message', public.chat_message_public_submission_payload(existing_message));
      end if;

      raise;
  end;

  begin
    classification := public.classify_chat_message(p_event_id, participant.id, inserted_message.id, normalized_body);
    v_now := clock_timestamp();

    update public.chat_messages
    set
      risk_level = classification->>'riskLevel',
      risk_score = (classification->>'riskScore')::integer,
      risk_flags = coalesce(ARRAY(SELECT jsonb_array_elements_text(classification->'riskFlags')), array[]::text[]),
      classified_at = v_now,
      classifier_version = classification->>'classifierVersion',
      auto_publish_eligible = (classification->>'autoPublishEligible')::boolean
        and not (
          coalesce(ARRAY(SELECT jsonb_array_elements_text(classification->'riskFlags')), array[]::text[])
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
        ),
      status = case
        when classification->>'riskLevel' = 'high' then 'rejected'
        when classification->>'riskLevel' = 'low'
          and (classification->>'autoPublishEligible')::boolean
          and not (
            coalesce(ARRAY(SELECT jsonb_array_elements_text(classification->'riskFlags')), array[]::text[])
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
          ) then 'queued'
        else 'pending'
      end,
      queued_at = case
        when classification->>'riskLevel' = 'low'
          and (classification->>'autoPublishEligible')::boolean
          and not (
            coalesce(ARRAY(SELECT jsonb_array_elements_text(classification->'riskFlags')), array[]::text[])
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
          ) then v_now
        else null
      end,
      rejected_at = case when classification->>'riskLevel' = 'high' then v_now else rejected_at end,
      rejection_source = case when classification->>'riskLevel' = 'high' then 'automatic_rules' else rejection_source end,
      rejection_reason = case when classification->>'riskLevel' = 'high' then 'automatic_rules' else rejection_reason end
    where id = inserted_message.id
    returning * into inserted_message;

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
    values (
      inserted_message.event_id,
      inserted_message.id,
      inserted_message.participant_id,
      null,
      'message_classified',
      'pending',
      inserted_message.status,
      null,
      inserted_message.risk_level,
      inserted_message.risk_flags,
      inserted_message.classifier_version
    );

    if inserted_message.status = 'queued' then
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
      values (
        inserted_message.event_id,
        inserted_message.id,
        inserted_message.participant_id,
        null,
        'message_queued',
        'pending',
        'queued',
        null,
        inserted_message.risk_level,
        inserted_message.risk_flags,
        inserted_message.classifier_version
      );
    elsif inserted_message.status = 'rejected' then
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
      values (
        inserted_message.event_id,
        inserted_message.id,
        inserted_message.participant_id,
        null,
        'message_auto_rejected',
        'pending',
        'rejected',
        'automatic_rules',
        inserted_message.risk_level,
        inserted_message.risk_flags,
        inserted_message.classifier_version
      );
    end if;
  exception
    when others then
      v_now := clock_timestamp();
      update public.chat_messages
      set
        risk_level = 'medium',
        risk_score = 0,
        risk_flags = array['CLASSIFIER_FAILURE'],
        classified_at = v_now,
        classifier_version = public.chat_message_risk_classifier_version(),
        auto_publish_eligible = false,
        status = 'pending',
        queued_at = null
      where id = inserted_message.id
      returning * into inserted_message;
  end;

  return jsonb_build_object('ok', true, 'duplicate', false, 'message', public.chat_message_public_submission_payload(inserted_message));
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, uuid, text, uuid) to anon, authenticated;
drop function if exists public.submit_chat_message(uuid, uuid, text, uuid);


create or replace function public.process_chat_auto_publish_queue(p_event_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_record public.events;
  message_record public.chat_messages;
  updated_message public.chat_messages;
  v_now timestamptz;
  processed_count integer := 0;
  skipped_count integer := 0;
  locked boolean;
begin
  for event_record in
    select *
    from public.events
    where (p_event_id is null or events.id = p_event_id)
      and events.status = 'live'
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
      and events.auto_publish_enabled = true
      and events.queue_paused = false
      and (events.next_auto_publish_at is null or events.next_auto_publish_at <= now())
    order by events.starts_at asc, events.id asc
  loop
    locked := pg_try_advisory_xact_lock(hashtext('chat-auto-publish:' || event_record.id::text));
    if not locked then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    v_now := clock_timestamp();

    select chat_messages.*
    into message_record
    from public.chat_messages
    where chat_messages.event_id = event_record.id
      and chat_messages.status = 'queued'
      and chat_messages.is_admin = false
      and exists (
        select 1
        from public.event_chat_participants
        where event_chat_participants.id = chat_messages.participant_id
          and event_chat_participants.event_id = chat_messages.event_id
      )
    order by chat_messages.queue_priority desc, chat_messages.queued_at asc, chat_messages.id asc
    for update skip locked
    limit 1;

    if message_record.id is null then
      continue;
    end if;

    if not public.is_chat_message_auto_publish_eligible(message_record) then
      update public.chat_messages
      set
        status = 'pending',
        auto_publish_eligible = false,
        queued_at = null,
        last_queue_error = 'queue_eligibility_revoked'
      where id = message_record.id
        and status = 'queued'
      returning * into updated_message;

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
      values (
        updated_message.event_id,
        updated_message.id,
        updated_message.participant_id,
        null,
        'queue_eligibility_revoked',
        'queued',
        'pending',
        'disqualifying_risk_flags',
        updated_message.risk_level,
        updated_message.risk_flags,
        updated_message.classifier_version
      );

      skipped_count := skipped_count + 1;
      continue;
    end if;

    update public.chat_messages
    set
      status = 'approved',
      approved_at = v_now,
      published_at = v_now,
      approved_by = null,
      approval_source = 'queue',
      queue_attempt_count = queue_attempt_count + 1,
      last_queue_error = null
    where id = message_record.id
      and public.is_chat_message_auto_publish_eligible(chat_messages)
    returning * into updated_message;

    if updated_message.id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    update public.events
    set
      last_auto_published_at = v_now,
      next_auto_publish_at = v_now + interval '3 seconds'
    where id = event_record.id;

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
    values (
      updated_message.event_id,
      updated_message.id,
      updated_message.participant_id,
      null,
      'message_auto_approved',
      'queued',
      'approved',
      'queue',
      updated_message.risk_level,
      updated_message.risk_flags,
      updated_message.classifier_version
    );

    processed_count := processed_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'processed', processed_count, 'skipped', skipped_count);
exception
  when others then
    if message_record.id is not null then
      update public.chat_messages
      set
        queue_attempt_count = queue_attempt_count + 1,
        last_queue_error = left(sqlerrm, 240)
      where id = message_record.id
        and status = 'queued';
    end if;
    return jsonb_build_object('ok', false, 'code', 'QUEUE_WORKER_FAILED', 'message', left(sqlerrm, 240));
end;
$$;

revoke all on function public.process_chat_auto_publish_queue(uuid) from public;
revoke all on function public.process_chat_auto_publish_queue(uuid) from anon, authenticated;

drop function if exists public.run_chat_auto_publish_queue_for_minute();

create or replace function public.process_chat_publish_queue(p_event_id uuid default null)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.process_chat_auto_publish_queue(p_event_id);
$$;

revoke all on function public.process_chat_publish_queue(uuid) from public;
revoke all on function public.process_chat_publish_queue(uuid) from anon, authenticated;

create extension if not exists pg_cron with schema extensions;

do $$
declare
  obsolete_job record;
begin
  for obsolete_job in
    select jobid, jobname, schedule, command, active
    from cron.job
    where jobname in (
      'process-chat-publish-queue',
      'process-chat-publish-queue-2',
      'process-chat-publish-queue-3',
      'process-chat-publish-queue-4',
      'process-chat-publish-queue-5',
      'process-chat-auto-publish-queue'
    )
  loop
    perform cron.unschedule(obsolete_job.jobid);
    raise notice 'Unscheduled obsolete chat queue job % (%)', obsolete_job.jobname, obsolete_job.jobid;
  end loop;
end;
$$;

select cron.schedule(
  'process-chat-publish-queue',
  '3 seconds',
  $$select public.process_chat_publish_queue();$$
);

-- Verification after applying this migration:
-- select jobid, jobname, schedule, command, active
-- from cron.job
-- where jobname like '%chat%publish%queue%';
-- Expected: exactly one active row named process-chat-publish-queue with schedule 3 seconds.
--
-- Check RLS:
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in ('chat_message_moderation_audit', 'chat_risk_terms');
-- Expected: relrowsecurity = true for both rows.
--
-- Check table privileges:
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name = 'chat_message_moderation_audit'
-- order by table_name, grantee, privilege_type;
-- Expected: authenticated has SELECT only; anon has no privileges; no client role has INSERT, UPDATE, DELETE, or TRUNCATE.
--
-- Check policies:
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('chat_message_moderation_audit', 'chat_risk_terms')
-- order by tablename, policyname;
-- Expected: audit table has only the owner-scoped SELECT policy for client access; risk-term table has no broad client policy.
--
-- Check function privileges:
-- select routine_name, grantee, privilege_type
-- from information_schema.routine_privileges
-- where routine_schema = 'public'
--   and routine_name in (
--     'classify_chat_message',
--     'is_chat_message_auto_publish_eligible',
--     'process_chat_auto_publish_queue',
--     'process_chat_publish_queue',
--     'submit_chat_message'
--   )
-- order by routine_name, grantee;
-- Expected: submit_chat_message executable by anon/authenticated; classifier, eligibility helper, and workers not executable by anon/authenticated.
--
-- Confirm only one visitor submission RPC exists:
-- select p.oid::regprocedure as signature
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname = 'submit_chat_message'
-- order by 1;
-- Expected: exactly one row: submit_chat_message(uuid,uuid,uuid,text,uuid).
--
-- Inspect repair outcomes:
-- select action, previous_status, new_status, count(*) as row_count
-- from public.chat_message_moderation_audit
-- where reason = 'link_social_promotion_safety_repair'
-- group by action, previous_status, new_status
-- order by action, previous_status, new_status;
-- Expected: queued->pending only for ineligible link/promotion rows; queued->rejected only for high-risk rows.
--
-- Confirm normal conversational mentions were not affected by the repair:
-- select count(*) as normal_mention_rows_affected
-- from public.chat_message_moderation_audit audit
-- join public.chat_messages message on message.id = audit.message_id
-- where audit.reason = 'link_social_promotion_safety_repair'
--   and public.normalize_chat_body_for_risk(message.body) in (
--     '@username great message',
--     'thanks @username',
--     'this is big @username',
--     'what do you think @username?',
--     'i agree with @username',
--     'nice one @username',
--     'original mix is great',
--     'big chorus',
--     'night was amazing'
--   );
-- Expected: 0.
--
-- Check cron:
-- select jobid, jobname, schedule, command, active
-- from cron.job
-- where jobname = 'process-chat-publish-queue';
-- Expected: exactly one active row, schedule 3 seconds.

with candidates as (
  select
    chat_messages.*,
    public.normalize_chat_body_for_risk(body) as normalized_body
  from public.chat_messages
  where status in ('pending', 'queued')
    and is_admin = false
    and (
      body ~* '(https?://|www\.)'
      or public.normalize_chat_body_for_risk(body) ~ '(^|[^[:alnum:]_@-])([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(com|org|net|edu|gov|io|co|uk|de|fr|it|es|nl|be|ch|at|se|no|dk|fi|pl|cz|ca|us|au|nz|jp|kr|cn|in|br|mx|tv|fm|me|app|dev|gg|ly|cloud|info|biz|xyz|shop|store|music|social)([/:?#][^[:space:]]*)?([^[:alnum:]_]|$)'
      or body ~* '([a-z0-9-]+\s*(\[dot\]|\(dot\)| dot )\s*[a-z]{2,})'
      or public.normalize_chat_body_for_risk(body) ~ '(follow me|follow my|follow @[a-z0-9_\.]|subscribe to me|subscribe to my|dm me|dm @[a-z0-9_\.]|message me|message me on|contact me|add me|add me on|send me a dm|hit me up|join my|check my page|check my profile|check out my account|check my account|my insta is|my instagram is|my ig is|my snap is|my snapchat is|my telegram is)'
      or (
        public.normalize_chat_body_for_risk(body) ~ '(^|[^a-z0-9])(instagram|insta|ig|tiktok|tik tok|twitter|snapchat|snap|discord|telegram|twitch|youtube|yt|soundcloud|spotify|facebook|fb)([^a-z0-9]|$)'
        and public.normalize_chat_body_for_risk(body) ~ '(^|[[:space:][:punct:]])@[a-z0-9][a-z0-9._]{1,28}[a-z0-9]([^a-z0-9._]|$)'
      )
      or (
        status = 'queued'
        and (
          risk_level is distinct from 'low'
          or auto_publish_eligible is distinct from true
          or published_at is not null
          or coalesce(risk_flags, array[]::text[]) && array[
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
      )
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
    auto_publish_eligible = case
      when decisions.status = 'queued' and decisions.next_queue_eligible then true
      else false
    end,
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
  'link_social_promotion_safety_repair',
  reclassified.risk_level,
  reclassified.risk_flags,
  reclassified.classifier_version
from reclassified
where not exists (
  select 1
  from public.chat_message_moderation_audit existing_audit
  where existing_audit.message_id = reclassified.id
    and existing_audit.reason = 'link_social_promotion_safety_repair'
    and existing_audit.previous_status = reclassified.previous_status
    and existing_audit.new_status = reclassified.status
);

notify pgrst, 'reload schema';
