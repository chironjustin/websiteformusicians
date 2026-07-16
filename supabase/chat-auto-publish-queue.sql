-- Durable low-risk chat queue and fixed-rate automatic publication.
-- Run after chat-risk-classification.sql and event-status-cron.sql.

alter table public.events
add column if not exists auto_publish_enabled boolean not null default false,
add column if not exists queue_paused boolean not null default false,
add column if not exists next_auto_publish_at timestamptz,
add column if not exists last_auto_published_at timestamptz;

alter table public.chat_messages
add column if not exists queued_at timestamptz,
add column if not exists queue_priority integer not null default 0,
add column if not exists queue_attempt_count integer not null default 0,
add column if not exists last_queue_error text;

alter table public.chat_messages
drop constraint if exists chat_messages_status_check;

alter table public.chat_messages
add constraint chat_messages_status_check
check (status in ('pending', 'queued', 'approved', 'rejected'));

alter table public.chat_messages
drop constraint if exists chat_messages_queue_state_check;

alter table public.chat_messages
add constraint chat_messages_queue_state_check
check (
  (status = 'queued' and queued_at is not null and published_at is null and risk_level = 'low' and auto_publish_eligible = true)
  or
  (status <> 'queued')
);

alter table public.chat_messages
drop constraint if exists chat_messages_queue_attempt_count_check;

alter table public.chat_messages
add constraint chat_messages_queue_attempt_count_check
check (queue_attempt_count >= 0);

create index if not exists chat_messages_event_queue_idx
on public.chat_messages(event_id, status, queue_priority desc, queued_at, id)
where status = 'queued';

create index if not exists chat_messages_event_auto_publish_idx
on public.chat_messages(event_id, auto_publish_eligible, status, queued_at)
where auto_publish_eligible = true;

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

alter table public.chat_message_moderation_audit
alter column message_id drop not null;

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

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
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
    and event_chat_participants.event_id = p_event_id;

  if participant.id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT', 'message', 'A reserved chat identity is required.');
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
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', to_jsonb(existing_message));
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
        return jsonb_build_object('ok', true, 'duplicate', true, 'message', to_jsonb(existing_message));
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

  return jsonb_build_object('ok', true, 'duplicate', false, 'message', to_jsonb(inserted_message));
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, uuid) to anon, authenticated;

create or replace function public.moderate_chat_message(
  p_message_id uuid,
  p_next_status text,
  p_reason text default null
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  target_message public.chat_messages;
  updated_message public.chat_messages;
  target_event public.events;
  audit_action text;
  cleaned_reason text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception 'NOT_EVENT_ADMIN';
  end if;

  if p_next_status not in ('approved', 'rejected') then
    raise exception 'INVALID_MESSAGE_STATE';
  end if;

  select chat_messages.*
  into target_message
  from public.chat_messages
  where chat_messages.id = p_message_id
  for update;

  if target_message.id is null then
    raise exception 'MESSAGE_NOT_FOUND';
  end if;

  select events.*
  into target_event
  from public.events
  where events.id = target_message.event_id
    and events.owner_id = auth.uid();

  if target_event.id is null then
    raise exception 'NOT_EVENT_ADMIN';
  end if;

  if target_message.status = p_next_status then
    return target_message;
  end if;

  if target_message.status not in ('pending', 'queued', 'rejected') then
    raise exception 'MESSAGE_ALREADY_MODERATED';
  end if;

  if target_message.status = 'rejected' and p_next_status <> 'approved' then
    raise exception 'INVALID_MESSAGE_STATE';
  end if;

  cleaned_reason := nullif(left(btrim(coalesce(p_reason, '')), 240), '');
  audit_action := case when p_next_status = 'approved' then 'message_approved' else 'message_rejected' end;

  update public.chat_messages
  set
    status = p_next_status,
    approved_at = case when p_next_status = 'approved' then v_now else approved_at end,
    published_at = case when p_next_status = 'approved' then v_now else null end,
    approved_by = case when p_next_status = 'approved' then auth.uid() else approved_by end,
    approval_source = case when p_next_status = 'approved' then 'manual' else approval_source end,
    rejected_at = case when p_next_status = 'rejected' then v_now else rejected_at end,
    rejected_by = case when p_next_status = 'rejected' then auth.uid() else rejected_by end,
    rejection_reason = case when p_next_status = 'rejected' then cleaned_reason else rejection_reason end,
    queued_at = case when p_next_status = 'rejected' then null else queued_at end,
    last_queue_error = case when p_next_status = 'approved' then null else last_queue_error end
  where id = target_message.id
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
    target_message.event_id,
    target_message.id,
    target_message.participant_id,
    auth.uid(),
    audit_action,
    target_message.status,
    updated_message.status,
    cleaned_reason,
    target_message.risk_level,
    target_message.risk_flags,
    target_message.classifier_version
  );

  return updated_message;
end;
$$;

revoke all on function public.moderate_chat_message(uuid, text, text) from public;
grant execute on function public.moderate_chat_message(uuid, text, text) to authenticated;

create or replace function public.set_event_chat_auto_publish_settings(
  p_event_id uuid,
  p_auto_publish_enabled boolean default null,
  p_queue_paused boolean default null
)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event public.events;
  updated_event public.events;
begin
  if auth.uid() is null then
    raise exception 'NOT_EVENT_ADMIN';
  end if;

  select *
  into target_event
  from public.events
  where id = p_event_id
    and owner_id = auth.uid()
  for update;

  if target_event.id is null then
    raise exception 'NOT_EVENT_ADMIN';
  end if;

  update public.events
  set
    auto_publish_enabled = coalesce(p_auto_publish_enabled, auto_publish_enabled),
    queue_paused = coalesce(p_queue_paused, queue_paused)
  where id = target_event.id
  returning * into updated_event;

  if p_auto_publish_enabled is not null and p_auto_publish_enabled is distinct from target_event.auto_publish_enabled then
    insert into public.chat_message_moderation_audit (
      event_id,
      message_id,
      participant_id,
      actor_id,
      action,
      previous_status,
      new_status,
      reason
    )
    values (
      updated_event.id,
      null,
      null,
      auth.uid(),
      case when p_auto_publish_enabled then 'auto_publish_enabled' else 'auto_publish_disabled' end,
      case when target_event.auto_publish_enabled then 'enabled' else 'disabled' end,
      case when updated_event.auto_publish_enabled then 'enabled' else 'disabled' end,
      null
    );
  end if;

  if p_queue_paused is not null and p_queue_paused is distinct from target_event.queue_paused then
    insert into public.chat_message_moderation_audit (
      event_id,
      message_id,
      participant_id,
      actor_id,
      action,
      previous_status,
      new_status,
      reason
    )
    values (
      updated_event.id,
      null,
      null,
      auth.uid(),
      case when p_queue_paused then 'queue_paused' else 'queue_resumed' end,
      case when target_event.queue_paused then 'paused' else 'running' end,
      case when updated_event.queue_paused then 'paused' else 'running' end,
      null
    );
  end if;

  return updated_event;
end;
$$;

revoke all on function public.set_event_chat_auto_publish_settings(uuid, boolean, boolean) from public;
grant execute on function public.set_event_chat_auto_publish_settings(uuid, boolean, boolean) to authenticated;

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

with revoked as (
  update public.chat_messages
  set
    status = 'pending',
    auto_publish_eligible = false,
    queued_at = null,
    published_at = null,
    last_queue_error = 'queue_eligibility_revoked'
  where status = 'queued'
    and not public.is_chat_message_auto_publish_eligible(chat_messages)
  returning *
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
  revoked.event_id,
  revoked.id,
  revoked.participant_id,
  null,
  'queue_eligibility_revoked',
  'queued',
  'pending',
  'migration_repair',
  revoked.risk_level,
  revoked.risk_flags,
  revoked.classifier_version
from revoked;

notify pgrst, 'reload schema';
