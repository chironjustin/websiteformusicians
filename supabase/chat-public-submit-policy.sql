-- Allows public visitors to submit moderated chat messages during the live event window.
-- Safe to rerun. Run after supabase/chat-schema.sql and supabase/schema.sql.

grant insert on public.chat_messages to anon, authenticated;

drop policy if exists "Visitors can submit pending chat messages" on public.chat_messages;
create policy "Visitors can submit pending chat messages"
on public.chat_messages
for insert
to anon, authenticated
with check (
  event_id is not null
  and user_id is null
  and status = 'pending'
  and is_admin = false
  and is_pinned = false
  and is_highlighted = false
  and is_liked = false
  and client_token is not null
  and legacy_assignment_confirmed_at is null
  and legacy_assignment_confirmed_by is null
  and char_length(btrim(display_name)) between 1 and 50
  and char_length(btrim(body)) between 1 and 500
  and exists (
    select 1
    from public.events
    where events.id = chat_messages.event_id
      and events.status in ('upcoming', 'live')
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
  )
);

notify pgrst, 'reload schema';
