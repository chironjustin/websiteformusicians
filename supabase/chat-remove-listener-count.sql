-- Remove the retired public listener-count RPC.
-- Chat capacity now depends only on event_chat_participants and event start time.

revoke all on function public.get_event_listener_count(uuid) from public;
drop function if exists public.get_event_listener_count(uuid);

notify pgrst, 'reload schema';
