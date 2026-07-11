-- Moderated live chat schema.
-- Run after supabase/schema.sql so public.events and public.set_updated_at exist.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  body text not null,
  status text not null default 'pending',
  is_admin boolean not null default false,
  is_pinned boolean not null default false,
  is_highlighted boolean not null default false,
  is_liked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_messages_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint chat_messages_display_name_length check (char_length(display_name) between 1 and 50),
  constraint chat_messages_body_length check (char_length(body) between 1 and 500)
);

create index if not exists chat_messages_event_status_created_idx on public.chat_messages(event_id, status, created_at);
create index if not exists chat_messages_event_pinned_created_idx on public.chat_messages(event_id, is_pinned desc, created_at);

drop trigger if exists set_chat_messages_updated_at on public.chat_messages;
create trigger set_chat_messages_updated_at
before update on public.chat_messages
for each row
execute function public.set_updated_at();

alter table public.chat_messages enable row level security;

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
create policy "Visitors can submit pending chat messages"
on public.chat_messages
for insert
with check (
  status = 'pending'
  and is_admin = false
  and is_pinned = false
  and is_highlighted = false
  and is_liked = false
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.status = 'live'
  )
);

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
