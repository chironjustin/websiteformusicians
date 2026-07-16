-- Moderated live chat schema.
-- Run after supabase/schema.sql so public.events and public.set_updated_at exist.

create table if not exists public.event_chat_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  session_id uuid not null,
  display_name text not null,
  normalized_name text not null,
  avatar_id text,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint event_chat_participants_display_name_length check (char_length(display_name) between 1 and 16),
  constraint event_chat_participants_normalized_name_length check (char_length(normalized_name) between 1 and 16)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  participant_id uuid references public.event_chat_participants(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  avatar_id text,
  body text not null,
  status text not null default 'pending',
  client_token uuid,
  is_admin boolean not null default false,
  is_pinned boolean not null default false,
  is_highlighted boolean not null default false,
  is_liked boolean not null default false,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  rejected_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejection_reason text,
  rejection_source text,
  approval_source text,
  risk_level text,
  risk_score integer,
  risk_flags text[] not null default array[]::text[],
  classified_at timestamptz,
  classifier_version text,
  auto_publish_eligible boolean not null default false,
  queued_at timestamptz,
  queue_priority integer not null default 0,
  queue_attempt_count integer not null default 0,
  last_queue_error text,
  legacy_assignment_confirmed_at timestamptz,
  legacy_assignment_confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_messages_status_check check (status in ('pending', 'queued', 'approved', 'rejected')),
  constraint chat_messages_display_name_length check (char_length(display_name) between 1 and 50),
  constraint chat_messages_body_length check (char_length(btrim(body)) between 1 and 400),
  constraint chat_messages_risk_level_check check (risk_level is null or risk_level in ('low', 'medium', 'high')),
  constraint chat_messages_risk_score_check check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  constraint chat_messages_published_at_status_check check (
    (status = 'approved' and published_at is not null)
    or
    (status <> 'approved' and published_at is null)
  ),
  constraint chat_messages_queue_state_check check (
    (status = 'queued' and queued_at is not null and published_at is null and risk_level = 'low' and auto_publish_eligible = true)
    or
    (status <> 'queued')
  ),
  constraint chat_messages_queue_attempt_count_check check (queue_attempt_count >= 0)
);

create unique index if not exists event_chat_participants_event_normalized_name_idx on public.event_chat_participants(event_id, normalized_name);
create unique index if not exists event_chat_participants_event_session_idx on public.event_chat_participants(event_id, session_id) where session_id is not null;
create index if not exists event_chat_participants_event_created_idx on public.event_chat_participants(event_id, created_at);
create index if not exists event_chat_participants_event_joined_idx on public.event_chat_participants(event_id, joined_at);
create index if not exists chat_messages_event_status_created_idx on public.chat_messages(event_id, status, created_at);
create index if not exists chat_messages_event_published_idx on public.chat_messages(event_id, status, published_at, id) where status = 'approved';
create index if not exists chat_messages_event_approved_published_cutoff_idx
on public.chat_messages(event_id, published_at, id)
where status = 'approved';
create index if not exists chat_messages_event_pinned_created_idx on public.chat_messages(event_id, is_pinned desc, created_at);
create index if not exists chat_messages_event_client_token_idx on public.chat_messages(event_id, client_token) where client_token is not null;
create index if not exists chat_messages_event_participant_idx on public.chat_messages(event_id, participant_id) where participant_id is not null;
create index if not exists chat_messages_event_participant_created_idx on public.chat_messages(event_id, participant_id, created_at desc) where event_id is not null and participant_id is not null;
create index if not exists chat_messages_created_at_idx on public.chat_messages(created_at);
create index if not exists chat_messages_event_queue_idx
on public.chat_messages(event_id, status, queue_priority desc, queued_at, id)
where status = 'queued';
create index if not exists chat_messages_event_auto_publish_idx
on public.chat_messages(event_id, auto_publish_eligible, status, queued_at)
where auto_publish_eligible = true;
create index if not exists chat_messages_event_queue_publish_budget_idx
on public.chat_messages(event_id, status, approval_source, published_at)
where status = 'approved'
  and approval_source = 'queue'
  and is_admin = false;
create index if not exists chat_messages_event_queue_fifo_idx
on public.chat_messages(event_id, status, queue_priority desc, queued_at, id)
where status = 'queued'
  and is_admin = false;

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
create unique index if not exists chat_messages_event_participant_client_token_idx
on public.chat_messages(event_id, participant_id, client_token)
where event_id is not null
  and participant_id is not null
  and client_token is not null;

create table if not exists public.chat_message_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete cascade,
  participant_id uuid references public.event_chat_participants(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('message_approved', 'message_rejected', 'message_classified', 'message_auto_rejected', 'message_queued', 'message_auto_approved', 'queue_eligibility_revoked', 'queue_paused', 'queue_resumed', 'auto_publish_enabled', 'auto_publish_disabled', 'queue_release_scheduled', 'queue_burst_released', 'queue_budget_throttled')),
  previous_status text not null,
  new_status text not null,
  reason text,
  risk_level text,
  risk_flags text[],
  classifier_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_message_moderation_audit_event_created_idx
on public.chat_message_moderation_audit(event_id, created_at desc);

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

with ranked_pins as (
  select
    id,
    row_number() over (
      partition by event_id
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.chat_messages
  where event_id is not null
    and is_pinned = true
)
update public.chat_messages
set is_pinned = false
where id in (
  select id from ranked_pins where row_number > 1
);

with ranked_highlights as (
  select
    id,
    row_number() over (
      partition by event_id
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.chat_messages
  where event_id is not null
    and is_highlighted = true
)
update public.chat_messages
set is_highlighted = false
where id in (
  select id from ranked_highlights where row_number > 1
);

create unique index if not exists chat_messages_one_pinned_per_event_idx
on public.chat_messages(event_id)
where event_id is not null
  and is_pinned = true;

create unique index if not exists chat_messages_one_highlighted_per_event_idx
on public.chat_messages(event_id)
where event_id is not null
  and is_highlighted = true;

create or replace function public.set_chat_message_publication_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if new.status = 'approved' then
    if new.published_at is null then
      new.published_at := v_now;
    end if;
    if new.approved_at is null then
      new.approved_at := new.published_at;
    end if;
    if new.approval_source is null then
      new.approval_source := case when new.is_admin then 'admin_direct' else 'manual' end;
    end if;
  else
    new.published_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists set_chat_message_publication_fields on public.chat_messages;
create trigger set_chat_message_publication_fields
before insert or update of status, published_at, approved_at, approval_source, is_admin
on public.chat_messages
for each row
execute function public.set_chat_message_publication_fields();

drop trigger if exists set_chat_messages_updated_at on public.chat_messages;
create trigger set_chat_messages_updated_at
before update on public.chat_messages
for each row
execute function public.set_updated_at();

alter table public.chat_messages enable row level security;
alter table public.event_chat_participants enable row level security;
alter table public.chat_message_moderation_audit enable row level security;

alter table public.chat_message_moderation_audit
alter column message_id drop not null;

grant insert on public.chat_messages to authenticated;
revoke insert on public.chat_messages from anon;
revoke select on public.chat_messages from anon;
grant select on public.chat_messages to authenticated;
revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated;

drop policy if exists "Public can read live event chat participants" on public.event_chat_participants;

drop policy if exists "Public can read approved chat messages" on public.chat_messages;

drop policy if exists "Visitors can submit pending chat messages" on public.chat_messages;

create or replace function public.get_visitor_chat_message_status(
  message_id uuid,
  message_event_id uuid,
  message_client_token uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select status
  from public.chat_messages
  where id = message_id
    and event_id = message_event_id
    and client_token = message_client_token
  limit 1;
$$;

revoke all on function public.get_visitor_chat_message_status(uuid, uuid, uuid) from public;
grant execute on function public.get_visitor_chat_message_status(uuid, uuid, uuid) to anon, authenticated;

create or replace function public.get_event_listener_count(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'count',
    coalesce((
      select count(*)::integer
      from public.event_chat_participants
      where event_chat_participants.event_id = p_event_id
    ), 0)
  );
$$;

revoke all on function public.get_event_listener_count(uuid) from public;
grant execute on function public.get_event_listener_count(uuid) to anon, authenticated;

create or replace function public.get_visitor_visible_chat_messages(
  p_event_id uuid,
  p_participant_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  event_id uuid,
  participant_id uuid,
  display_name text,
  body text,
  status text,
  client_token uuid,
  is_admin boolean,
  is_pinned boolean,
  is_highlighted boolean,
  is_liked boolean,
  created_at timestamptz,
  updated_at timestamptz,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with verified_participant as (
    select *
    from public.event_chat_participants
    where event_chat_participants.id = p_participant_id
      and event_chat_participants.event_id = p_event_id
      and event_chat_participants.session_id = p_session_id
    limit 1
  )
  select
    chat_messages.id,
    chat_messages.event_id,
    chat_messages.participant_id,
    chat_messages.display_name,
    chat_messages.body,
    chat_messages.status,
    case
      when chat_messages.participant_id = p_participant_id then chat_messages.client_token
      else null
    end as client_token,
    chat_messages.is_admin,
    chat_messages.is_pinned,
    chat_messages.is_highlighted,
    chat_messages.is_liked,
    chat_messages.created_at,
    chat_messages.updated_at,
    chat_messages.published_at
  from public.chat_messages
  cross join verified_participant
  where chat_messages.event_id = p_event_id
    and exists (
      select 1
      from public.events
      where events.id = chat_messages.event_id
        and events.status in ('live', 'finished')
    )
    and (
      (
        chat_messages.status = 'approved'
        and chat_messages.published_at >= verified_participant.joined_at
      )
      or chat_messages.participant_id = p_participant_id
    )
  order by
    chat_messages.is_pinned desc,
    case
      when chat_messages.participant_id = p_participant_id then chat_messages.created_at
      else chat_messages.published_at
    end asc nulls last,
    chat_messages.id asc;
$$;

revoke all on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) from public;
grant execute on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) to anon, authenticated;

create or replace function public.normalize_chat_name(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(btrim(regexp_replace(coalesce(p_value, ''), '[[:space:]]+', ' ', 'g')));
$$;

do $$
begin
  if to_regprocedure('public.reserve_event_chat_identity(uuid, text, text, text)') is not null then
    revoke all on function public.reserve_event_chat_identity(uuid, text, text, text) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.reserve_event_chat_identity(uuid, uuid, text, text, text)') is not null then
    revoke all on function public.reserve_event_chat_identity(uuid, uuid, text, text, text) from public, anon, authenticated;
  end if;
end;
$$;

drop function if exists public.chat_generated_first_names();

drop function if exists public.join_event_chat(uuid, uuid);

create or replace function public.join_event_chat(
  p_event_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  event_id uuid,
  session_id uuid,
  display_name text,
  normalized_name text,
  created_at timestamptz,
  joined_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  event_artist_name text;
  existing_participant public.event_chat_participants;
  inserted_participant public.event_chat_participants;
  base_name text;
  base_normalized text;
  candidate_name text;
  normalized_candidate text;
  existing_base_name text;
  should_reassign_existing boolean := false;
  attempt integer;
  suffix_number integer;
begin
  if p_event_id is null then
    raise exception 'chat_event_required';
  end if;

  if p_session_id is null then
    raise exception 'chat_session_required';
  end if;

  select events.artist_name
  into event_artist_name
  from public.events
  where events.id = p_event_id
    and events.status in ('upcoming', 'live')
    and events.starts_at is not null
    and events.ends_at is not null
    and events.starts_at <= now()
    and events.ends_at > now();

  if event_artist_name is null then
    raise exception 'chat_event_not_live';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_session_id::text));

  select *
  into existing_participant
  from public.event_chat_participants
  where event_chat_participants.event_id = p_event_id
    and event_chat_participants.session_id = p_session_id
  limit 1;

  if existing_participant.id is not null then
    existing_base_name := regexp_replace(existing_participant.display_name, '[0-9]+$', '');

    if exists (
      select 1
      from public.chat_name_pool pool
      where pool.is_active = true
        and pool.normalized_name = public.normalize_chat_name(existing_base_name)
    ) then
      update public.event_chat_participants
      set last_seen_at = now()
      where event_chat_participants.id = existing_participant.id
      returning * into existing_participant;

      return query
        select
          existing_participant.id,
          existing_participant.event_id,
          existing_participant.session_id,
          existing_participant.display_name,
          existing_participant.normalized_name,
          existing_participant.created_at,
          existing_participant.joined_at,
          existing_participant.last_seen_at;
      return;
    end if;

    should_reassign_existing := true;
  end if;

  if existing_participant.id is not null and should_reassign_existing = false then
    update public.event_chat_participants
    set last_seen_at = now()
    where event_chat_participants.id = existing_participant.id
    returning * into existing_participant;

    return query
      select
        existing_participant.id,
        existing_participant.event_id,
        existing_participant.session_id,
        existing_participant.display_name,
        existing_participant.normalized_name,
        existing_participant.created_at,
        existing_participant.joined_at,
        existing_participant.last_seen_at;
    return;
  end if;

  for attempt in 1..25 loop
    select picked.base_name, picked.normalized_name
    into base_name, base_normalized
    from public.pick_chat_base_name(event_artist_name) picked
    limit 1;

    if base_name is null then
      raise exception 'chat_name_pool_empty';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || base_normalized));

    for suffix_number in 1..50 loop
      if suffix_number = 1 then
        candidate_name := left(base_name, 16);
      else
        candidate_name := left(base_name, greatest(1, 16 - char_length(suffix_number::text))) || suffix_number::text;
        raise log 'chat_name_suffix base_name=% suffix_number=% suffix_added=%', base_name, suffix_number, true;
      end if;

      normalized_candidate := public.normalize_chat_name(candidate_name);

      if normalized_candidate in ('admin', 'administrator', 'artist', 'moderator', 'mod', 'official', 'system', 'support') then
        continue;
      end if;

      if normalized_candidate = public.normalize_chat_name(event_artist_name) then
        continue;
      end if;

      begin
        if should_reassign_existing then
          update public.event_chat_participants
          set display_name = candidate_name,
              normalized_name = normalized_candidate,
              last_seen_at = now()
          where event_chat_participants.id = existing_participant.id
          returning * into inserted_participant;
        else
          insert into public.event_chat_participants (
            event_id,
            session_id,
            display_name,
            normalized_name,
            joined_at,
            last_seen_at
          )
          values (
            p_event_id,
            p_session_id,
            candidate_name,
            normalized_candidate,
            now(),
            now()
          )
          returning * into inserted_participant;
        end if;

        return query
          select
            inserted_participant.id,
            inserted_participant.event_id,
            inserted_participant.session_id,
            inserted_participant.display_name,
            inserted_participant.normalized_name,
            inserted_participant.created_at,
            inserted_participant.joined_at,
            inserted_participant.last_seen_at;
        return;
      exception
        when unique_violation then
          select *
          into existing_participant
          from public.event_chat_participants
          where event_chat_participants.event_id = p_event_id
            and event_chat_participants.session_id = p_session_id
          limit 1;

          if existing_participant.id is not null and should_reassign_existing = false then
            return query
              select
                existing_participant.id,
                existing_participant.event_id,
                existing_participant.session_id,
                existing_participant.display_name,
                existing_participant.normalized_name,
                existing_participant.created_at,
                existing_participant.joined_at,
                existing_participant.last_seen_at;
            return;
          end if;
      end;
    end loop;
  end loop;

  raise exception 'chat_name_allocation_failed';
end;
$$;

revoke all on function public.join_event_chat(uuid, uuid) from public;
grant execute on function public.join_event_chat(uuid, uuid) to anon, authenticated;

create table if not exists public.chat_risk_terms (
  id bigint generated by default as identity primary key,
  term text not null,
  normalized_term text not null,
  match_mode text not null default 'substring' check (match_mode in ('exact', 'substring', 'word')),
  risk text not null check (risk in ('review', 'hard')),
  flag text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint chat_risk_terms_term_not_empty check (char_length(btrim(term)) > 0)
);

alter table public.chat_risk_terms
drop constraint if exists chat_risk_terms_match_mode_check;

alter table public.chat_risk_terms
add constraint chat_risk_terms_match_mode_check
check (match_mode in ('exact', 'substring', 'word'));

create unique index if not exists chat_risk_terms_normalized_mode_risk_idx
on public.chat_risk_terms(normalized_term, match_mode, risk, flag);

alter table public.chat_risk_terms enable row level security;
revoke select, insert, update, delete, truncate on public.chat_risk_terms from anon, authenticated;

insert into public.chat_risk_terms (term, normalized_term, match_mode, risk, flag)
values
  ('kill yourself', 'kill yourself', 'substring', 'hard', 'THREAT'),
  ('go die', 'go die', 'substring', 'hard', 'THREAT'),
  ('i hope you die', 'i hope you die', 'substring', 'hard', 'THREAT'),
  ('kys', 'kys', 'exact', 'hard', 'THREAT'),
  ('test-hate-speech-term', 'test-hate-speech-term', 'exact', 'hard', 'HATE_SPEECH'),
  ('fuck', 'fuck', 'word', 'review', 'PROFANITY'),
  ('shit', 'shit', 'word', 'review', 'PROFANITY'),
  ('bitch', 'bitch', 'word', 'review', 'PROFANITY'),
  ('asshole', 'asshole', 'word', 'review', 'PROFANITY'),
  ('official admin announcement', 'official admin announcement', 'substring', 'review', 'ADMIN_IMPERSONATION'),
  ('moderator here', 'moderator here', 'substring', 'review', 'ADMIN_IMPERSONATION')
on conflict (normalized_term, match_mode, risk, flag) do nothing;

create or replace function public.normalize_chat_body_for_risk(p_body text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')));
$$;

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
        score := score + 25;
      end if;
    end if;
  end loop;

  score := least(score, 100);

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

drop function if exists public.submit_chat_message(uuid, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, uuid, text, uuid);

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

create or replace function public.set_chat_message_pin(
  p_message_id uuid,
  p_pinned boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event_id uuid;
begin
  select chat_messages.event_id
  into target_event_id
  from public.chat_messages
  join public.events on events.id = chat_messages.event_id
  where chat_messages.id = p_message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if p_pinned then
    update public.chat_messages
    set is_pinned = false
    where event_id = target_event_id
      and id <> p_message_id
      and is_pinned = true;
  end if;

  update public.chat_messages
  set is_pinned = p_pinned
  where id = p_message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_pin(uuid, boolean) from public;
grant execute on function public.set_chat_message_pin(uuid, boolean) to authenticated;

create or replace function public.set_chat_message_highlight(
  p_message_id uuid,
  p_highlighted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event_id uuid;
begin
  select chat_messages.event_id
  into target_event_id
  from public.chat_messages
  join public.events on events.id = chat_messages.event_id
  where chat_messages.id = p_message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if p_highlighted then
    update public.chat_messages
    set is_highlighted = false
    where event_id = target_event_id
      and id <> p_message_id
      and is_highlighted = true;
  end if;

  update public.chat_messages
  set is_highlighted = p_highlighted
  where id = p_message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_highlight(uuid, boolean) from public;
grant execute on function public.set_chat_message_highlight(uuid, boolean) to authenticated;

drop policy if exists "Owners can read all chat messages" on public.chat_messages;
create policy "Owners can read all chat messages"
on public.chat_messages
for select
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Authenticated admins can read unassigned legacy chat messages" on public.chat_messages;
create policy "Authenticated admins can read unassigned legacy chat messages"
on public.chat_messages
for select
to authenticated
using (event_id is null);

drop policy if exists "Owners can insert admin chat messages" on public.chat_messages;
create policy "Owners can insert admin chat messages"
on public.chat_messages
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'approved'
  and is_admin = true
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Owners can moderate chat messages" on public.chat_messages;
create policy "Owners can moderate chat messages"
on public.chat_messages
for update
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

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

drop policy if exists "Authenticated admins can assign unassigned legacy chat messages"drop policy if exists "Authenticated admins can assign unassigned legacy chat messages" on public.chat_messages;
create policy "Authenticated admins can assign unassigned legacy chat messages"
on public.chat_messages
for update
to authenticated
using (event_id is null)
with check (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Owners can delete chat messages" on public.chat_messages;
create policy "Owners can delete chat messages"
on public.chat_messages
for delete
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

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

-- Optional but recommended for realtime subscriptions:
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

-- alter publication supabase_realtime add table public.chat_messages;

notify pgrst, 'reload schema';
