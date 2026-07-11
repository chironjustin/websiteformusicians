# Music Event Website

A Vite + React + TypeScript app for musicians to tease unreleased music. The public page reads the current event dynamically from Supabase, while the protected admin dashboard manages drafts, scheduling, manual start/end actions, uploads, and support links.

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
3. Create these Storage buckets:
   - `artist-images` public
   - `artwork` public
   - `merch-images` public
   - `audio` private
4. In the SQL editor, run `supabase/storage-policies.sql` after the buckets exist.
5. Enable email/password Auth.
6. Create the first admin user in Supabase Auth.
7. Add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values locally and in Vercel.

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
- Realtime does not update: confirm Realtime is enabled for `public.events` or use the built-in periodic refetch fallback.
