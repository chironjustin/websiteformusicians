-- Multi-message moderation visibility for public visitors.
-- Allows a joined visitor to read approved public messages plus their own event-scoped messages.

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
  order by chat_messages.is_pinned desc, chat_messages.created_at asc;
$$;

revoke all on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) from public;
grant execute on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
