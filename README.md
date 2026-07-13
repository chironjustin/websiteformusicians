# Music Event Website

A Vite + React + TypeScript app for musicians to tease unreleased music. The public page reads the current event dynamically from Supabase, while the protected admin dashboard manages drafts, event activation, manual ending, uploads, support links, and moderated live chat.

## Local Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy environment variables:

   ```sh
   cp .env.example .env.local
   ```

3. Fill in `.env.local`:

   ```sh
   VITE_SUPABASE_URL=
   VITE_SUPABASE_ANON_KEY=
   ```

4. Start the app:

   ```sh
   npm run dev
   ```

5. Build for production:

   ```sh
   npm run build
   ```

Vite outputs to `dist`.

## Supabase Setup

1. Create a Supabase project.
2. In the SQL editor, run `supabase/schema.sql`.
3. In the SQL editor, run `supabase/event-end-times-migration.sql` to backfill explicit event end timestamps for any older duration-based events.
4. In the SQL editor, run `supabase/chat-schema.sql`.
5. In the SQL editor, run `supabase/chat-pending-status.sql` for existing projects or after chat setup.
6. In the SQL editor, run `supabase/chat-public-submit-policy.sql` so public Live chat submissions are accepted only as pending messages during the live timestamp window.
7. In the SQL editor, run `supabase/event-status-cron.sql`.
8. Create these Storage buckets:
   - `artist-images` public
   - `artwork` public
   - `merch-images` public
   - `audio` private
9. In the SQL editor, run `supabase/storage-policies.sql` after the buckets exist.
10. Enable email/password Auth.
11. Create the first admin user in Supabase Auth.
12. Enable Realtime for `public.events` and optionally `public.chat_messages`.
13. Add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values locally and in Vercel.

The private `audio` bucket is not publicly readable. Authenticated event owners still need SELECT access to their own `user-id/event-id/file` objects so Supabase can create signed admin preview and playback URLs.

Event timestamps are stored as UTC `timestamptz` values. The admin editor converts them to local browser time for `datetime-local` inputs and converts local input back to UTC when saving.

Pressing `Start Event` publishes the timestamp-driven event flow. If `starts_at` is still in the future, the public page appears as Upcoming and counts down to that timestamp. If `starts_at <= now < ends_at`, it appears as Live. The selected `starts_at` timestamp controls when an event becomes `live`; the explicit `ends_at` timestamp controls when it becomes `finished`. The legacy `duration_hours` column may remain for compatibility, but new event edits use `starts_at` and `ends_at` directly. The cron job in `supabase/event-status-cron.sql` runs every minute and Realtime delivers those database changes to open public/admin clients.

## Moderated Chat

- Visitor messages are inserted as `pending`.
- Public pages read only `approved` messages.
- The admin Chat tab can approve, reject, delete, pin, highlight, and like messages.
- Admin-composed messages publish immediately as approved messages with an Admin badge.

## Routes

- `/` public teaser page
- `/login` Supabase email/password login
- `/admin` protected admin dashboard

## Vercel Deployment

The included `vercel.json` config uses:

- framework: `vite`
- build command: `npm run build`
- output directory: `dist`
- SPA rewrite to `/index.html`

Add these Vercel environment variables:

```sh
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Do not add a service-role key to Vercel or frontend code.

## Troubleshooting

- Missing environment variables: set both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Cannot access `/admin`: sign in at `/login` with a Supabase Auth user.
- Draft does not appear publicly: this is expected. Only `upcoming`, `live`, and `finished` events are publicly readable.
- Audio does not play: confirm the `audio` bucket is private, the storage policies were applied, and the event has an uploaded audio path.
- Realtime does not update: confirm Realtime is enabled for `public.events` and `public.chat_messages`.
