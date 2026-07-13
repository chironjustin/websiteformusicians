# Setup Checklist

## Supabase

- [ ] Create a Supabase project.
- [ ] Enable email/password authentication.
- [ ] Create the first admin user in Supabase Auth.
- [ ] Run `supabase/schema.sql` in the SQL editor.
- [ ] Run `supabase/event-end-times-migration.sql` in the SQL editor to backfill explicit end timestamps for older duration-based events.
- [ ] Run `supabase/chat-schema.sql` in the SQL editor.
- [ ] Run `supabase/chat-pending-status.sql` in the SQL editor for pending-message status tracking.
- [ ] Run `supabase/archive-delete-audit.sql` in the SQL editor for permanent archived-event deletion audit logs.
- [ ] Run `supabase/event-status-cron.sql` in the SQL editor.
- [ ] Confirm Supabase Cron is enabled/available and the `update-event-statuses` job runs every minute.
- [ ] Deploy the `supabase/functions/delete-archived-event` Edge Function.
- [ ] Configure the Edge Function with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Supabase function secrets. Never add the service-role key to frontend environment variables.
- [ ] Create Storage bucket `artist-images` as public.
- [ ] Create Storage bucket `artwork` as public.
- [ ] Create Storage bucket `merch-images` as public.
- [ ] Create Storage bucket `audio` as private.
- [ ] Run `supabase/storage-policies.sql` after creating buckets.
- [ ] Confirm authenticated users can SELECT their own scoped storage files so private audio signed URLs can be created.
- [ ] Enable Realtime for `public.events`.
- [ ] Optionally enable Realtime for `public.chat_messages`.
- [ ] Copy the project URL into `VITE_SUPABASE_URL`.
- [ ] Copy the anon public key into `VITE_SUPABASE_ANON_KEY`.
- [ ] Do not use or expose the service-role key in this frontend app.

## Local Development

- [ ] Run `npm install`.
- [ ] Create `.env.local` from `.env.example`.
- [ ] Fill in `VITE_SUPABASE_URL`.
- [ ] Fill in `VITE_SUPABASE_ANON_KEY`.
- [ ] Run `npm run dev`.
- [ ] Sign in at `/login`.
- [ ] Create and save a draft at `/admin`.
- [ ] Upload artwork or artist image.
- [ ] Upload audio.
- [ ] Select local Event Start Date and Time and Event End Date and Time values and confirm both still display the same local times after save/refresh.
- [ ] Press `Start Event`.
- [ ] Confirm `/` updates without a redeploy.
- [ ] Submit a visitor chat message on `/` during a live event.
- [ ] Confirm the message appears as pending in `/admin`.
- [ ] Approve the message and confirm it appears publicly.
- [ ] Test pin, highlight, like, reject, and delete moderation actions.

## Vercel

- [ ] Import the project into Vercel.
- [ ] Confirm build command is `npm run build`.
- [ ] Confirm output directory is `dist`.
- [ ] Add `VITE_SUPABASE_URL`.
- [ ] Add `VITE_SUPABASE_ANON_KEY`.
- [ ] Deploy.
- [ ] Visit `/login` and confirm admin login works.
- [ ] Visit `/` and confirm the public page reads from Supabase.
