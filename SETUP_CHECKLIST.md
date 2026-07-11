# Setup Checklist

## Supabase

- [ ] Create a Supabase project.
- [ ] Enable email/password authentication.
- [ ] Create the first admin user in Supabase Auth.
- [ ] Run `supabase/schema.sql` in the SQL editor.
- [ ] Create Storage bucket `artist-images` as public.
- [ ] Create Storage bucket `artwork` as public.
- [ ] Create Storage bucket `merch-images` as public.
- [ ] Create Storage bucket `audio` as private.
- [ ] Run `supabase/storage-policies.sql` after creating buckets.
- [ ] Optionally enable Realtime for `public.events`.
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
- [ ] Schedule or start the event.
- [ ] Confirm `/` updates without a redeploy.

## Vercel

- [ ] Import the project into Vercel.
- [ ] Confirm build command is `npm run build`.
- [ ] Confirm output directory is `dist`.
- [ ] Add `VITE_SUPABASE_URL`.
- [ ] Add `VITE_SUPABASE_ANON_KEY`.
- [ ] Deploy.
- [ ] Visit `/login` and confirm admin login works.
- [ ] Visit `/` and confirm the public page reads from Supabase.
