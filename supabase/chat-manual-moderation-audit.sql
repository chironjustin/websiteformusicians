-- Manual chat moderation metadata and audit logging.

alter table public.chat_messages
add column if not exists approved_at timestamptz,
add column if not exists approved_by uuid references auth.users(id) on delete set null,
add column if not exists published_at timestamptz,
add column if not exists rejected_at timestamptz,
add column if not exists rejected_by uuid references auth.users(id) on delete set null,
add column if not exists rejection_reason text,
add column if not exists approval_source text;

create table if not exists public.chat_message_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('message_approved', 'message_rejected')),
  previous_status text not null,
  new_status text not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists chat_message_moderation_audit_event_created_idx
on public.chat_message_moderation_audit(event_id, created_at desc);

alter table public.chat_message_moderation_audit enable row level security;

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
    actor_id,
    action,
    previous_status,
    new_status,
    reason
  )
  values (
    target_message.event_id,
    target_message.id,
    auth.uid(),
    audit_action,
    target_message.status,
    updated_message.status,
    cleaned_reason
  );

  return updated_message;
end;
$$;

revoke all on function public.moderate_chat_message(uuid, text, text) from public;
grant execute on function public.moderate_chat_message(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
