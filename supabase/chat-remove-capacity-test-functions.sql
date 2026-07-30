-- Remove temporary chat-capacity testing RPCs.
-- Production uses public.join_event_chat and public.get_chat_admission_status.

revoke all on function public.join_event_chat_test(uuid, uuid) from public;
revoke all on function public.get_chat_admission_status_test(uuid, uuid) from public;

drop function if exists public.join_event_chat_test(uuid, uuid);
drop function if exists public.get_chat_admission_status_test(uuid, uuid);

notify pgrst, 'reload schema';
