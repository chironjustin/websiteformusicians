-- Harden public release timestamps for cursor correctness.
--
-- published_at is the public release cursor. It must be assigned exactly when a
-- message first becomes approved/public and must not be changed by later
-- metadata updates.

create or replace function public.set_chat_message_publication_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if new.status = 'approved' then
    if tg_op = 'INSERT' then
      new.published_at := v_now;
      new.approved_at := v_now;
    elsif old.status is distinct from 'approved' then
      new.published_at := v_now;
      new.approved_at := v_now;
    elsif new.published_at is distinct from old.published_at then
      new.published_at := old.published_at;
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

notify pgrst, 'reload schema';

-- Verification:
-- select pg_get_functiondef('public.set_chat_message_publication_fields()'::regprocedure);
