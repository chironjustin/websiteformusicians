-- Public chat submission is now handled by event-scoped participants.
-- Run supabase/chat-participants-migration.sql instead of the old direct submit RPC.

notify pgrst, 'reload schema';
