-- Step 3 curated live-chat publication timestamps and feed ordering.

alter table public.chat_messages
add column if not exists published_at timestamptz;

update public.chat_messages
set published_at = coalesce(approved_at, created_at)
where status = 'approved'
  and published_at is null;

update public.chat_messages
set published_at = null
where status <> 'approved'
  and published_at is not null;

alter table public.chat_messages
drop constraint if exists chat_messages_published_at_status_check;

alter table public.chat_messages
add constraint chat_messages_published_at_status_check
check (
  (status = 'approved' and published_at is not null)
  or
  (status <> 'approved' and published_at is null)
);

create index if not exists chat_messages_event_published_idx
on public.chat_messages(event_id, status, published_at, id)
where status = 'approved';

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
