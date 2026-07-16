-- Make the current approved pinned message available to joined public visitors
-- even when it was published before their join cutoff.
-- Normal public history remains cutoff-aware through published_at >= joined_at.

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
        and (
          chat_messages.published_at >= verified_participant.joined_at
          or chat_messages.is_pinned = true
        )
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

notify pgrst, 'reload schema';

-- Verification:
-- select p.oid::regprocedure as signature
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname = 'get_visitor_visible_chat_messages';
--
-- Confirm the active approved pin can be returned independently from the join cutoff:
-- select id, body, is_pinned, status, published_at
-- from public.chat_messages
-- where event_id = '<EVENT_ID>'
--   and status = 'approved'
--   and is_pinned = true;
