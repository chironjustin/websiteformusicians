-- End an event using trusted database time.
-- Run after supabase/schema.sql.

create or replace function public.end_event_now(p_event_id uuid)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  finished_event public.events;
begin
  if auth.uid() is null then
    raise exception 'event_owner_required';
  end if;

  update public.events
  set status = 'finished',
      ends_at = case
        when starts_at is not null and now() <= starts_at then starts_at + interval '1 second'
        else now()
      end
  where events.id = p_event_id
    and events.owner_id = auth.uid()
  returning * into finished_event;

  if finished_event.id is null then
    raise exception 'event_not_found';
  end if;

  return finished_event;
end;
$$;

revoke all on function public.end_event_now(uuid) from public;
grant execute on function public.end_event_now(uuid) to authenticated;

notify pgrst, 'reload schema';
