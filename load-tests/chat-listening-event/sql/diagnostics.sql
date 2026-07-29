-- Read-only diagnostics for staging load tests.
-- Replace <EVENT_ID> before running. Do not run EXPLAIN ANALYZE against production.

-- Active chat queue cron jobs. Expected: exactly one active process-chat-publish-queue job.
select jobid, jobname, schedule, command, active
from cron.job
where jobname like '%chat%publish%queue%'
order by jobname;

-- Event scheduler state.
select
  id,
  status,
  starts_at,
  ends_at,
  auto_publish_enabled,
  queue_paused,
  last_auto_published_at,
  next_auto_publish_at,
  current_queue_size,
  current_queue_band,
  last_calculated_delay_ms,
  last_release_size,
  recent_fan_publish_count,
  publication_budget_per_minute,
  scheduler_version
from public.events
where id = '<EVENT_ID>';

-- Queue depth and oldest queued age.
select
  event_id,
  count(*) filter (where status = 'queued') as total_queued,
  count(*) filter (
    where status = 'queued'
      and risk_level = 'low'
      and auto_publish_eligible = true
      and not (coalesce(risk_flags, array[]::text[]) && array[
        'CONTAINS_LINK',
        'OBFUSCATED_LINK',
        'UNSAFE_PROTOCOL',
        'SOCIAL_PROMOTION',
        'FOLLOW_SOLICITATION',
        'CONTACT_SOLICITATION',
        'SOCIAL_HANDLE',
        'CLASSIFIER_FAILURE'
      ]::text[])
  ) as eligible_queued,
  min(queued_at) filter (where status = 'queued') as oldest_queued_at,
  now() - min(queued_at) filter (where status = 'queued') as oldest_queued_age
from public.chat_messages
where event_id = '<EVENT_ID>'
group by event_id;

-- Recent queue-approved publication count.
select
  count(*) as queue_publications_last_minute,
  min(published_at) as first_recent_publication,
  max(published_at) as last_recent_publication
from public.chat_messages
where event_id = '<EVENT_ID>'
  and status = 'approved'
  and approval_source = 'queue'
  and is_admin = false
  and published_at > now() - interval '60 seconds';

-- Publication spacing inspection.
with ordered as (
  select
    id,
    participant_id,
    published_at,
    lag(published_at) over (order by published_at, id) as previous_published_at
  from public.chat_messages
  where event_id = '<EVENT_ID>'
    and status = 'approved'
    and approval_source = 'queue'
  order by published_at desc
  limit 200
)
select
  id,
  participant_id,
  published_at,
  extract(epoch from (published_at - previous_published_at)) * 1000 as gap_ms
from ordered
order by published_at desc;

-- Duplicate approval sanity check.
select message_id, action, count(*)
from public.chat_message_moderation_audit
where event_id = '<EVENT_ID>'
  and action = 'message_auto_approved'
group by message_id, action
having count(*) > 1;

-- Recent submission outcomes by status/risk.
select
  status,
  risk_level,
  classifier_version,
  count(*)
from public.chat_messages
where event_id = '<EVENT_ID>'
  and created_at > now() - interval '30 minutes'
group by status, risk_level, classifier_version
order by status, risk_level;

-- Index usage overview.
select
  schemaname,
  relname as table_name,
  indexrelname as index_name,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
from pg_stat_user_indexes
where relname in ('chat_messages', 'event_chat_participants', 'events')
order by relname, idx_scan desc;

-- Lock waits/deadlocks overview.
select datname, deadlocks, temp_files, temp_bytes
from pg_stat_database
where datname = current_database();

-- Connection utilization.
select state, count(*)
from pg_stat_activity
where datname = current_database()
group by state
order by state;

-- Optional staging-only plan checks. These execute the query; do not run against production.
-- explain (analyze, buffers)
-- select *
-- from public.chat_messages
-- where event_id = '<EVENT_ID>'
--   and status = 'queued'
-- order by queue_priority desc, queued_at asc, id asc
-- limit 1;
--
-- explain (analyze, buffers)
-- select *
-- from public.chat_messages
-- where event_id = '<EVENT_ID>'
--   and status = 'approved'
--   and published_at >= now() - interval '10 minutes'
-- order by published_at asc, id asc;
