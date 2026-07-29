-- Cursor-based visitor chat reads.
-- Preserves the product rule that public visibility starts at the participant's
-- trusted joined_at timestamp. A null public cursor means "bootstrap from my
-- joined_at boundary", not "load historical event chat".

create or replace function public.get_visitor_visible_chat_message_delta(
  p_event_id uuid,
  p_participant_id uuid,
  p_session_id uuid,
  p_after_published_at timestamptz default null,
  p_after_id uuid default null,
  p_after_public_updated_at timestamptz default null,
  p_after_public_updated_id uuid default null,
  p_after_private_updated_at timestamptz default null,
  p_after_private_id uuid default null,
  p_limit integer default 200
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
  published_at timestamptz,
  visibility_scope text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with request as (
    select
      greatest(1, least(coalesce(p_limit, 200), 500)) as page_limit,
      statement_timestamp() as snapshot_at
  ),
  verified_participant as (
    select *
    from public.event_chat_participants
    where event_chat_participants.id = p_participant_id
      and event_chat_participants.event_id = p_event_id
      and event_chat_participants.session_id = p_session_id
    limit 1
  ),
  active_pin as (
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
      chat_messages.published_at,
      'active_pin'::text as visibility_scope
    from public.chat_messages
    cross join verified_participant
    cross join request
    where chat_messages.event_id = p_event_id
      and exists (
        select 1
        from public.events
        where events.id = chat_messages.event_id
          and events.status in ('live', 'finished')
      )
      and chat_messages.status = 'approved'
      and chat_messages.is_pinned = true
      and chat_messages.published_at is not null
      and chat_messages.published_at >= verified_participant.joined_at
      and chat_messages.published_at <= request.snapshot_at
    order by
      chat_messages.updated_at desc,
      chat_messages.id desc
    limit 1
  ),
  public_new_delta as (
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
      chat_messages.published_at,
      'public_new'::text as visibility_scope
    from public.chat_messages
    cross join verified_participant
    cross join request
    where chat_messages.event_id = p_event_id
      and exists (
        select 1
        from public.events
        where events.id = chat_messages.event_id
          and events.status in ('live', 'finished')
      )
      and chat_messages.status = 'approved'
      and chat_messages.published_at is not null
      and chat_messages.published_at <= request.snapshot_at
      and chat_messages.published_at >= verified_participant.joined_at
      and (
        p_after_published_at is null
        or chat_messages.published_at > p_after_published_at
        or (
          chat_messages.published_at = p_after_published_at
          and (
            p_after_id is null
            or chat_messages.id > p_after_id
          )
        )
      )
    order by
      chat_messages.published_at asc,
      chat_messages.id asc
    limit (select page_limit from request)
  ),
  public_update_delta as (
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
      chat_messages.published_at,
      'public_update'::text as visibility_scope
    from public.chat_messages
    cross join verified_participant
    cross join request
    where chat_messages.event_id = p_event_id
      and exists (
        select 1
        from public.events
        where events.id = chat_messages.event_id
          and events.status in ('live', 'finished')
      )
      and chat_messages.status = 'approved'
      and chat_messages.published_at is not null
      and chat_messages.published_at <= request.snapshot_at
      and chat_messages.published_at >= verified_participant.joined_at
      and chat_messages.updated_at <= request.snapshot_at
      and (
        p_after_public_updated_at is null
        or chat_messages.updated_at > p_after_public_updated_at
        or (
          chat_messages.updated_at = p_after_public_updated_at
          and (
            p_after_public_updated_id is null
            or chat_messages.id > p_after_public_updated_id
          )
        )
      )
    order by
      chat_messages.updated_at asc,
      chat_messages.id asc
    limit (select page_limit from request)
  ),
  private_delta as (
    select
      chat_messages.id,
      chat_messages.event_id,
      chat_messages.participant_id,
      chat_messages.display_name,
      chat_messages.body,
      chat_messages.status,
      chat_messages.client_token,
      chat_messages.is_admin,
      chat_messages.is_pinned,
      chat_messages.is_highlighted,
      chat_messages.is_liked,
      chat_messages.created_at,
      chat_messages.updated_at,
      chat_messages.published_at,
      'own'::text as visibility_scope
    from public.chat_messages
    cross join verified_participant
    cross join request
    where chat_messages.event_id = p_event_id
      and chat_messages.participant_id = p_participant_id
      and (
        p_after_private_updated_at is null
        or chat_messages.updated_at > p_after_private_updated_at
        or (
          chat_messages.updated_at = p_after_private_updated_at
          and (
            p_after_private_id is null
            or chat_messages.id > p_after_private_id
          )
        )
      )
    order by
      chat_messages.updated_at asc,
      chat_messages.id asc
    limit (select page_limit from request)
  )
    select * from active_pin
    union all
    select * from public_new_delta
    union all
    select * from public_update_delta
    union all
    select * from private_delta;
$$;

drop function if exists public.get_visitor_visible_chat_message_delta(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer);
revoke all on function public.get_visitor_visible_chat_message_delta(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, timestamptz, uuid, integer) from public;
grant execute on function public.get_visitor_visible_chat_message_delta(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, timestamptz, uuid, integer) to anon, authenticated;

notify pgrst, 'reload schema';

-- Verification: the delta RPC exists and remains the only steady-state visitor
-- read path needed by the public client.
-- select p.oid::regprocedure as signature
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'get_visitor_visible_chat_messages',
--     'get_visitor_visible_chat_message_delta'
--   )
-- order by 1;

-- Verification: approved-public new-message delta can use the existing published cursor index.
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'chat_messages'
--   and indexname in (
--     'chat_messages_event_published_idx',
--     'chat_messages_event_approved_published_cutoff_idx',
--     'chat_messages_event_participant_created_idx'
--   );
