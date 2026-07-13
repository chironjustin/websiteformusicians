-- Allows public visitors to submit moderated chat messages during the live event window.
-- Safe to rerun. Run after supabase/chat-schema.sql and supabase/schema.sql.

drop policy if exists "Visitors can submit pending chat messages" on public.chat_messages;
revoke insert on public.chat_messages from anon;

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_display_name text,
  p_body text,
  p_client_token uuid
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_display_name text;
  normalized_body text;
  inserted_message public.chat_messages;
begin
  normalized_display_name := btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]]+', ' ', 'g'));
  normalized_body := btrim(regexp_replace(coalesce(p_body, ''), '[[:space:]]+', ' ', 'g'));

  if p_event_id is null then
    raise exception 'A current live event is required.';
  end if;

  if p_client_token is null then
    raise exception 'A client token is required.';
  end if;

  if normalized_display_name = '' or char_length(normalized_display_name) > 50 then
    raise exception 'Display name must be between 1 and 50 characters.';
  end if;

  if normalized_body = '' or char_length(normalized_body) > 500 then
    raise exception 'Message must be between 1 and 500 characters.';
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
    raise exception 'Chat is open only during a live event.';
  end if;

  insert into public.chat_messages (
    event_id,
    user_id,
    display_name,
    body,
    status,
    client_token,
    is_admin,
    is_pinned,
    is_highlighted,
    is_liked,
    legacy_assignment_confirmed_at,
    legacy_assignment_confirmed_by
  )
  values (
    p_event_id,
    null,
    normalized_display_name,
    normalized_body,
    'pending',
    p_client_token,
    false,
    false,
    false,
    false,
    null,
    null
  )
  returning * into inserted_message;

  return inserted_message;
end;
$$;

revoke all on function public.submit_chat_message(uuid, text, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, text, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
