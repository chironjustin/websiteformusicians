-- Natural queue pacing for the curated live-chat auto publisher.
-- Run after chat-auto-publish-queue.sql and chat-artist-live-v3-classifier.sql.

alter table public.events
add column if not exists current_queue_size integer not null default 0,
add column if not exists current_queue_band text,
add column if not exists last_calculated_delay_ms integer,
add column if not exists last_release_size integer not null default 0,
add column if not exists recent_fan_publish_count integer not null default 0,
add column if not exists publication_budget_per_minute integer not null default 20,
add column if not exists scheduler_version text;

alter table public.events
drop constraint if exists events_chat_scheduler_counts_check;

alter table public.events
add constraint events_chat_scheduler_counts_check
check (
  current_queue_size >= 0
  and last_release_size >= 0
  and recent_fan_publish_count >= 0
  and publication_budget_per_minute > 0
  and (last_calculated_delay_ms is null or last_calculated_delay_ms >= 0)
);

alter table public.chat_message_moderation_audit
add column if not exists metadata jsonb not null default '{}'::jsonb;

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
    'auto_publish_disabled',
    'queue_release_scheduled',
    'queue_burst_released',
    'queue_budget_throttled'
  )
);

create index if not exists chat_messages_event_queue_publish_budget_idx
on public.chat_messages(event_id, status, approval_source, published_at)
where status = 'approved'
  and approval_source = 'queue'
  and is_admin = false;

create index if not exists chat_messages_event_queue_fifo_idx
on public.chat_messages(event_id, status, queue_priority desc, queued_at, id)
where status = 'queued'
  and is_admin = false;

create or replace function public.get_chat_publish_timing_band(p_queue_size integer)
returns table (
  queue_band text,
  min_delay_ms integer,
  max_delay_ms integer,
  budget_per_minute integer,
  burst_probability numeric,
  target_pace text
)
language sql
immutable
set search_path = public
as $$
  select *
  from (
    values
      ('empty'::text, 800, 2000, 20, 0.00::numeric, 'empty-to-active'),
      ('0-30'::text, 1800, 4500, 20, 0.10::numeric, 'about 1 message every 3 seconds'),
      ('31-100'::text, 1000, 3200, 30, 0.12::numeric, 'about 1 message every 2 seconds'),
      ('101-200'::text, 500, 1800, 60, 0.15::numeric, 'about 1 message per second'),
      ('over-200'::text, 350, 1400, 90, 0.15::numeric, 'adaptive up to 90 messages per minute')
  ) as timing(queue_band, min_delay_ms, max_delay_ms, budget_per_minute, burst_probability, target_pace)
  where case
    when greatest(coalesce(p_queue_size, 0), 0) = 0 then timing.queue_band = 'empty'
    when p_queue_size between 1 and 30 then timing.queue_band = '0-30'
    when p_queue_size between 31 and 100 then timing.queue_band = '31-100'
    when p_queue_size between 101 and 200 then timing.queue_band = '101-200'
    else timing.queue_band = 'over-200'
  end
  limit 1;
$$;

revoke all on function public.get_chat_publish_timing_band(integer) from public, anon, authenticated;

create or replace function public.calculate_chat_publish_delay_ms(
  p_queue_size integer,
  p_recent_count integer,
  p_budget_per_minute integer
)
returns integer
language plpgsql
volatile
set search_path = public
as $$
declare
  timing record;
  weighted_random numeric;
  base_delay numeric;
  usage_ratio numeric;
  multiplier numeric := 1.0;
  delay_ms integer;
begin
  select *
  into timing
  from public.get_chat_publish_timing_band(greatest(coalesce(p_queue_size, 0), 0));

  weighted_random := (random() + random() + random()) / 3.0;
  base_delay := timing.min_delay_ms + weighted_random * (timing.max_delay_ms - timing.min_delay_ms);
  usage_ratio := case
    when coalesce(p_budget_per_minute, 0) <= 0 then 1.0
    else greatest(coalesce(p_recent_count, 0), 0)::numeric / p_budget_per_minute::numeric
  end;

  multiplier := case
    when usage_ratio < 0.50 then 0.90
    when usage_ratio < 0.80 then 1.00
    when usage_ratio < 1.00 then 1.35
    else 1.75
  end;

  delay_ms := round(base_delay * multiplier)::integer;
  return greatest(timing.min_delay_ms, least(delay_ms, greatest(timing.max_delay_ms * 2, timing.max_delay_ms)));
end;
$$;

revoke all on function public.calculate_chat_publish_delay_ms(integer, integer, integer) from public, anon, authenticated;

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
    queue_paused = coalesce(p_queue_paused, queue_paused),
    next_auto_publish_at = case
      when p_auto_publish_enabled is true or p_queue_paused is false then null
      else next_auto_publish_at
    end,
    scheduler_version = 'natural-v1'
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
      reason,
      metadata
    )
    values (
      updated_event.id,
      null,
      null,
      auth.uid(),
      case when p_auto_publish_enabled then 'auto_publish_enabled' else 'auto_publish_disabled' end,
      case when target_event.auto_publish_enabled then 'enabled' else 'disabled' end,
      case when updated_event.auto_publish_enabled then 'enabled' else 'disabled' end,
      null,
      jsonb_build_object('schedulerVersion', 'natural-v1')
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
      reason,
      metadata
    )
    values (
      updated_event.id,
      null,
      null,
      auth.uid(),
      case when p_queue_paused then 'queue_paused' else 'queue_resumed' end,
      case when target_event.queue_paused then 'paused' else 'running' end,
      case when updated_event.queue_paused then 'paused' else 'running' end,
      null,
      jsonb_build_object('schedulerVersion', 'natural-v1')
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
  first_message public.chat_messages;
  second_message public.chat_messages;
  updated_first public.chat_messages;
  updated_second public.chat_messages;
  timing record;
  v_now timestamptz;
  second_release_at timestamptz;
  processed_count integer := 0;
  skipped_count integer := 0;
  locked boolean;
  eligible_queue_size integer := 0;
  recent_count integer := 0;
  slots_remaining integer := 0;
  release_size integer := 1;
  delay_ms integer := 0;
  second_gap_ms integer := 0;
  oldest_recent_at timestamptz;
  throttle_delay_ms integer := 0;
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
    first_message := null;
    second_message := null;
    updated_first := null;
    updated_second := null;
    release_size := 1;

    select count(*)::integer
    into eligible_queue_size
    from public.chat_messages
    where chat_messages.event_id = event_record.id
      and chat_messages.status = 'queued'
      and chat_messages.is_admin = false
      and public.is_chat_message_auto_publish_eligible(chat_messages)
      and exists (
        select 1
        from public.event_chat_participants
        where event_chat_participants.id = chat_messages.participant_id
          and event_chat_participants.event_id = chat_messages.event_id
      );

    select *
    into timing
    from public.get_chat_publish_timing_band(eligible_queue_size);

    if eligible_queue_size = 0 then
      update public.events
      set
        current_queue_size = 0,
        current_queue_band = timing.queue_band,
        recent_fan_publish_count = 0,
        publication_budget_per_minute = timing.budget_per_minute,
        last_release_size = 0,
        last_calculated_delay_ms = null,
        next_auto_publish_at = null,
        scheduler_version = 'natural-v1'
      where id = event_record.id;
      continue;
    end if;

    if event_record.next_auto_publish_at is null then
      delay_ms := public.calculate_chat_publish_delay_ms(0, 0, timing.budget_per_minute);
      update public.events
      set
        current_queue_size = eligible_queue_size,
        current_queue_band = timing.queue_band,
        recent_fan_publish_count = 0,
        publication_budget_per_minute = timing.budget_per_minute,
        last_release_size = 0,
        last_calculated_delay_ms = delay_ms,
        next_auto_publish_at = v_now + (delay_ms::text || ' milliseconds')::interval,
        scheduler_version = 'natural-v1'
      where id = event_record.id;
      continue;
    end if;

    select count(*)::integer, min(published_at)
    into recent_count, oldest_recent_at
    from public.chat_messages
    where chat_messages.event_id = event_record.id
      and chat_messages.status = 'approved'
      and chat_messages.approval_source = 'queue'
      and chat_messages.is_admin = false
      and chat_messages.published_at > v_now - interval '60 seconds';

    slots_remaining := greatest(timing.budget_per_minute - coalesce(recent_count, 0), 0);

    if slots_remaining <= 0 then
      throttle_delay_ms := greatest(
        timing.min_delay_ms,
        least(
          60000,
          ceiling(extract(epoch from ((coalesce(oldest_recent_at, v_now) + interval '60 seconds') - v_now)) * 1000)::integer
        )
      );

      update public.events
      set
        current_queue_size = eligible_queue_size,
        current_queue_band = timing.queue_band,
        recent_fan_publish_count = recent_count,
        publication_budget_per_minute = timing.budget_per_minute,
        last_release_size = 0,
        last_calculated_delay_ms = throttle_delay_ms,
        next_auto_publish_at = v_now + (throttle_delay_ms::text || ' milliseconds')::interval,
        scheduler_version = 'natural-v1'
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
        metadata
      )
      values (
        event_record.id,
        null,
        null,
        null,
        'queue_budget_throttled',
        'queued',
        'queued',
        'rolling_budget_full',
        jsonb_build_object(
          'queueBand', timing.queue_band,
          'queueSize', eligible_queue_size,
          'recentFanPublishCount', recent_count,
          'budgetPerMinute', timing.budget_per_minute,
          'delayMs', throttle_delay_ms,
          'schedulerVersion', 'natural-v1'
        )
      );

      skipped_count := skipped_count + 1;
      continue;
    end if;

    select chat_messages.*
    into first_message
    from public.chat_messages
    where chat_messages.event_id = event_record.id
      and chat_messages.status = 'queued'
      and chat_messages.is_admin = false
      and public.is_chat_message_auto_publish_eligible(chat_messages)
      and exists (
        select 1
        from public.event_chat_participants
        where event_chat_participants.id = chat_messages.participant_id
          and event_chat_participants.event_id = chat_messages.event_id
      )
    order by chat_messages.queue_priority desc, chat_messages.queued_at asc, chat_messages.id asc
    for update skip locked
    limit 1;

    if first_message.id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    if slots_remaining >= 2
      and eligible_queue_size >= 2
      and random() < timing.burst_probability::double precision then
      select chat_messages.*
      into second_message
      from public.chat_messages
      where chat_messages.event_id = event_record.id
        and chat_messages.status = 'queued'
        and chat_messages.is_admin = false
        and chat_messages.id <> first_message.id
        and chat_messages.participant_id is distinct from first_message.participant_id
        and public.normalize_chat_body_for_risk(chat_messages.body) <> public.normalize_chat_body_for_risk(first_message.body)
        and public.is_chat_message_auto_publish_eligible(chat_messages)
        and exists (
          select 1
          from public.event_chat_participants
          where event_chat_participants.id = chat_messages.participant_id
            and event_chat_participants.event_id = chat_messages.event_id
        )
      order by chat_messages.queue_priority desc, chat_messages.queued_at asc, chat_messages.id asc
      for update skip locked
      limit 1;

      if second_message.id is not null then
        release_size := 2;
        second_gap_ms := 150 + floor(random() * 451)::integer;
        second_release_at := v_now + (second_gap_ms::text || ' milliseconds')::interval;
      end if;
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
    where id = first_message.id
      and public.is_chat_message_auto_publish_eligible(chat_messages)
    returning * into updated_first;

    if updated_first.id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    if release_size = 2 then
      update public.chat_messages
      set
        status = 'approved',
        approved_at = second_release_at,
        published_at = second_release_at,
        approved_by = null,
        approval_source = 'queue',
        queue_attempt_count = queue_attempt_count + 1,
        last_queue_error = null
      where id = second_message.id
        and public.is_chat_message_auto_publish_eligible(chat_messages)
      returning * into updated_second;

      if updated_second.id is null then
        release_size := 1;
        second_gap_ms := 0;
      end if;
    end if;

    delay_ms := public.calculate_chat_publish_delay_ms(
      greatest(eligible_queue_size - release_size, 0),
      recent_count + release_size,
      timing.budget_per_minute
    );

    update public.events
    set
      last_auto_published_at = case when release_size = 2 then second_release_at else v_now end,
      next_auto_publish_at = case
        when greatest(eligible_queue_size - release_size, 0) = 0 then null
        else (case when release_size = 2 then second_release_at else v_now end) + (delay_ms::text || ' milliseconds')::interval
      end,
      current_queue_size = greatest(eligible_queue_size - release_size, 0),
      current_queue_band = timing.queue_band,
      last_calculated_delay_ms = case when greatest(eligible_queue_size - release_size, 0) = 0 then null else delay_ms end,
      last_release_size = release_size,
      recent_fan_publish_count = recent_count + release_size,
      publication_budget_per_minute = timing.budget_per_minute,
      scheduler_version = 'natural-v1'
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
      classifier_version,
      metadata
    )
    values (
      updated_first.event_id,
      updated_first.id,
      updated_first.participant_id,
      null,
      'message_auto_approved',
      'queued',
      'approved',
      'queue',
      updated_first.risk_level,
      updated_first.risk_flags,
      updated_first.classifier_version,
      jsonb_build_object(
        'queueBand', timing.queue_band,
        'queueSize', eligible_queue_size,
        'releaseSize', release_size,
        'delayMs', delay_ms,
        'recentFanPublishCount', recent_count,
        'budgetPerMinute', timing.budget_per_minute,
        'publishedAt', v_now,
        'schedulerVersion', 'natural-v1'
      )
    );

    if release_size = 2 and updated_second.id is not null then
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
        classifier_version,
        metadata
      )
      values (
        updated_second.event_id,
        updated_second.id,
        updated_second.participant_id,
        null,
        'message_auto_approved',
        'queued',
        'approved',
        'queue',
        updated_second.risk_level,
        updated_second.risk_flags,
        updated_second.classifier_version,
        jsonb_build_object(
          'queueBand', timing.queue_band,
          'queueSize', eligible_queue_size,
          'releaseSize', release_size,
          'burstGapMs', second_gap_ms,
          'delayMs', delay_ms,
          'recentFanPublishCount', recent_count,
          'budgetPerMinute', timing.budget_per_minute,
          'publishedAt', second_release_at,
          'schedulerVersion', 'natural-v1'
        )
      );

      insert into public.chat_message_moderation_audit (
        event_id,
        message_id,
        participant_id,
        actor_id,
        action,
        previous_status,
        new_status,
        reason,
        metadata
      )
      values (
        event_record.id,
        null,
        null,
        null,
        'queue_burst_released',
        'queued',
        'approved',
        'two_message_burst',
        jsonb_build_object(
          'queueBand', timing.queue_band,
          'queueSize', eligible_queue_size,
          'releaseSize', release_size,
          'burstGapMs', second_gap_ms,
          'delayMs', delay_ms,
          'recentFanPublishCount', recent_count,
          'budgetPerMinute', timing.budget_per_minute,
          'schedulerVersion', 'natural-v1'
        )
      );
    end if;

    if greatest(eligible_queue_size - release_size, 0) > 0 then
      insert into public.chat_message_moderation_audit (
        event_id,
        message_id,
        participant_id,
        actor_id,
        action,
        previous_status,
        new_status,
        reason,
        metadata
      )
      values (
        event_record.id,
        null,
        null,
        null,
        'queue_release_scheduled',
        'queued',
        'queued',
        'next_release_scheduled',
        jsonb_build_object(
          'queueBand', timing.queue_band,
          'queueSize', greatest(eligible_queue_size - release_size, 0),
          'releaseSize', release_size,
          'delayMs', delay_ms,
          'nextAutoPublishAt', (case when release_size = 2 then second_release_at else v_now end) + (delay_ms::text || ' milliseconds')::interval,
          'recentFanPublishCount', recent_count + release_size,
          'budgetPerMinute', timing.budget_per_minute,
          'schedulerVersion', 'natural-v1'
        )
      );
    end if;

    processed_count := processed_count + release_size;
  end loop;

  return jsonb_build_object('ok', true, 'processed', processed_count, 'skipped', skipped_count);
exception
  when others then
    if first_message.id is not null then
      update public.chat_messages
      set
        queue_attempt_count = queue_attempt_count + 1,
        last_queue_error = left(sqlerrm, 240)
      where id = first_message.id
        and status = 'queued';
    end if;
    return jsonb_build_object('ok', false, 'code', 'QUEUE_WORKER_FAILED', 'message', left(sqlerrm, 240));
end;
$$;

revoke all on function public.process_chat_auto_publish_queue(uuid) from public;
revoke all on function public.process_chat_auto_publish_queue(uuid) from anon, authenticated;

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

update public.events
set
  next_auto_publish_at = null,
  current_queue_size = 0,
  current_queue_band = null,
  last_calculated_delay_ms = null,
  last_release_size = 0,
  recent_fan_publish_count = 0,
  publication_budget_per_minute = 20,
  scheduler_version = 'natural-v1'
where scheduler_version is distinct from 'natural-v1';

notify pgrst, 'reload schema';

-- Verification after applying:
-- select jobid, jobname, schedule, command, active
-- from cron.job
-- where jobname like '%chat%publish%queue%';
--
-- select
--   id,
--   auto_publish_enabled,
--   queue_paused,
--   last_auto_published_at,
--   next_auto_publish_at,
--   current_queue_band,
--   last_calculated_delay_ms,
--   last_release_size,
--   recent_fan_publish_count,
--   publication_budget_per_minute,
--   scheduler_version
-- from public.events
-- order by updated_at desc;
--
-- select event_id, participant_id, body, published_at, approval_source
-- from public.chat_messages
-- where status = 'approved'
--   and approval_source = 'queue'
-- order by published_at desc
-- limit 100;
