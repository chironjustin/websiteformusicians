-- Legacy chat archive support.
-- Run after supabase/chat-schema.sql.
--
-- New application code still requires event_id for every newly-created public
-- and admin chat message. This migration only allows old legacy rows to remain
-- unassigned until an admin explicitly reviews and assigns them.

alter table public.chat_messages
alter column event_id drop not null;

alter table public.chat_messages
add column if not exists legacy_assignment_confirmed_at timestamptz;

alter table public.chat_messages
add column if not exists legacy_assignment_confirmed_by uuid references auth.users(id) on delete set null;

create index if not exists chat_messages_created_at_idx
on public.chat_messages(created_at);

drop policy if exists "Authenticated admins can read unassigned legacy chat messages"
on public.chat_messages;

create policy "Authenticated admins can read unassigned legacy chat messages"
on public.chat_messages
for select
to authenticated
using (event_id is null);

drop policy if exists "Authenticated admins can assign unassigned legacy chat messages"
on public.chat_messages;

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
