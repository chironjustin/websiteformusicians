-- Pending-message status remains in supabase/chat-schema.sql.
-- Public visitor submission now requires an event participant from
-- supabase/chat-participants-migration.sql.

notify pgrst, 'reload schema';
