-- Moderated live chat schema.
-- Run after supabase/schema.sql so public.events and public.set_updated_at exist.

create table if not exists public.event_chat_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  session_id uuid not null,
  display_name text not null,
  normalized_name text not null,
  avatar_id text,
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
  legacy_assignment_confirmed_at timestamptz,
  legacy_assignment_confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_messages_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint chat_messages_display_name_length check (char_length(display_name) between 1 and 50),
  constraint chat_messages_body_length check (char_length(btrim(body)) between 1 and 400),
  constraint chat_messages_risk_level_check check (risk_level is null or risk_level in ('low', 'medium', 'high')),
  constraint chat_messages_risk_score_check check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  constraint chat_messages_published_at_status_check check (
    (status = 'approved' and published_at is not null)
    or
    (status <> 'approved' and published_at is null)
  )
);

create unique index if not exists event_chat_participants_event_normalized_name_idx on public.event_chat_participants(event_id, normalized_name);
create unique index if not exists event_chat_participants_event_session_idx on public.event_chat_participants(event_id, session_id) where session_id is not null;
create index if not exists event_chat_participants_event_created_idx on public.event_chat_participants(event_id, created_at);
create index if not exists chat_messages_event_status_created_idx on public.chat_messages(event_id, status, created_at);
create index if not exists chat_messages_event_published_idx on public.chat_messages(event_id, status, published_at, id) where status = 'approved';
create index if not exists chat_messages_event_pinned_created_idx on public.chat_messages(event_id, is_pinned desc, created_at);
create index if not exists chat_messages_event_client_token_idx on public.chat_messages(event_id, client_token) where client_token is not null;
create index if not exists chat_messages_event_participant_idx on public.chat_messages(event_id, participant_id) where participant_id is not null;
create index if not exists chat_messages_event_participant_created_idx on public.chat_messages(event_id, participant_id, created_at desc) where event_id is not null and participant_id is not null;
create index if not exists chat_messages_created_at_idx on public.chat_messages(created_at);
create unique index if not exists chat_messages_event_participant_client_token_idx
on public.chat_messages(event_id, participant_id, client_token)
where event_id is not null
  and participant_id is not null
  and client_token is not null;

create table if not exists public.chat_message_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  participant_id uuid references public.event_chat_participants(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('message_approved', 'message_rejected', 'message_classified', 'message_auto_rejected')),
  previous_status text not null,
  new_status text not null,
  reason text,
  risk_level text,
  risk_flags text[],
  classifier_version text,
  created_at timestamptz not null default now()
);

create index if not exists chat_message_moderation_audit_event_created_idx
on public.chat_message_moderation_audit(event_id, created_at desc);

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

grant insert on public.chat_messages to authenticated;
revoke insert on public.chat_messages from anon;
revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated;

drop policy if exists "Public can read live event chat participants" on public.event_chat_participants;

drop policy if exists "Public can read approved chat messages" on public.chat_messages;
create policy "Public can read approved chat messages"
on public.chat_messages
for select
using (
  status = 'approved'
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.status in ('live', 'finished')
  )
);

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

create or replace function public.get_visitor_visible_chat_messages(
  p_event_id uuid,
  p_participant_id uuid,
  p_session_id uuid
)
returns setof public.chat_messages
language sql
stable
security definer
set search_path = public
as $$
  select chat_messages.*
  from public.chat_messages
  where chat_messages.event_id = p_event_id
    and (
      chat_messages.status = 'approved'
      or (
        chat_messages.participant_id = p_participant_id
        and exists (
          select 1
          from public.event_chat_participants
          where event_chat_participants.id = p_participant_id
            and event_chat_participants.event_id = p_event_id
            and event_chat_participants.session_id = p_session_id
        )
      )
    )
    and exists (
      select 1
      from public.events
      where events.id = chat_messages.event_id
        and events.status in ('live', 'finished')
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
            last_seen_at
          )
          values (
            p_event_id,
            p_session_id,
            candidate_name,
            normalized_candidate,
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
revoke select, insert, update, delete on public.chat_risk_terms from anon, authenticated;

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
  select 'rules-v1';
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

  if clean_body ~* '(https?://|www\.)' then
    flags := array_append(flags, 'CONTAINS_LINK');
    score := score + 25;
  end if;

  if clean_body ~* '(javascript|data|file)\s*:' then
    flags := array_append(flags, 'UNSAFE_PROTOCOL');
    force_high := true;
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

  if clean_body ~ '(.)\1{14,}' then
    flags := array_append(flags, 'REPEATED_CHARACTERS');
    force_high := true;
  elsif clean_body ~ '(.)\1{7,}' or clean_body ~ '[!?.,]{12,}' then
    flags := array_append(flags, 'REPEATED_CHARACTERS');
    score := score + 20;
  end if;

  if position(U&'\200B' in clean_body) > 0
    or position(U&'\200C' in clean_body) > 0
    or position(U&'\200D' in clean_body) > 0
    or position(U&'\FEFF' in clean_body) > 0 then
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

  if clean_body ~ '[!?]{10,}' then
    flags := array_append(flags, 'EXCESSIVE_PUNCTUATION');
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

drop function if exists public.submit_chat_message(uuid, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, uuid);

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
      auto_publish_eligible = (classification->>'autoPublishEligible')::boolean,
      status = case when classification->>'riskLevel' = 'high' then 'rejected' else 'pending' end,
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

    if inserted_message.status = 'rejected' then
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
        status = 'pending'
      where id = inserted_message.id
      returning * into inserted_message;
  end;

  return jsonb_build_object('ok', true, 'duplicate', false, 'message', to_jsonb(inserted_message));
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, uuid) to anon, authenticated;

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

  if target_message.status not in ('pending', 'rejected') then
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
    rejection_reason = case when p_next_status = 'rejected' then cleaned_reason else rejection_reason end
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

drop policy if exists "Authenticated admins can assign unassigned legacy chat messages" on public.chat_messages;
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

-- Optional but recommended for realtime subscriptions:
-- alter publication supabase_realtime add table public.chat_messages;

notify pgrst, 'reload schema';
