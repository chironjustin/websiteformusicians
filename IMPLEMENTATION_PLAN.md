# Supabase Integration Implementation Plan

## Phase 1 audit findings

- The app is a Vite + React + TypeScript project generated from Figma.
- The public teaser UI, admin dashboard, event setup controls, file selectors, chat, and event state preview are all currently implemented in `src/app/App.tsx`.
- `src/main.tsx` imports `./app/App.tsx`; there is no separate route tree yet.
- Routing is not configured with React Router. The admin dashboard is currently shown when the URL query string contains `?admin`; otherwise the public page renders.
- `react-router` is installed, but no router APIs are currently used. Because client-side routes are required for `/`, `/admin`, and `/login`, the Vercel SPA rewrite will be needed.
- Event information is stored only in local React state inside `App`. The initial event is hardcoded with title `Gravity`, empty file URLs, a start time three minutes in the future, and a twelve-hour duration.
- Mock/hardcoded behavior is used for event state, messages, uploads, and admin controls.
- The original prototype's start/end buttons mutated local state only. The production admin now uses `Start Event` to publish the timestamp-driven flow and `End Now` to finish it.
- File selectors currently create temporary `blob:` preview URLs with `URL.createObjectURL`. No file is uploaded or persisted.
- Existing field coverage includes song title, start datetime, duration, audio, artwork, artist image, support URL, merchandise URL, event URL, and merchandise image.
- React and React DOM are currently listed as optional peer dependencies rather than normal dependencies. That must be corrected for production installs.
- There is no `tsconfig` file in the project. TypeScript is being transpiled by Vite rather than checked by a dedicated TypeScript compiler step.
- No existing Supabase code, `.env.example`, `.gitignore`, `vercel.json`, or lockfile was present at audit time.
- The working folder was not initially a Git repository. Git was initialized locally and the `supabase-integration` branch was created before implementation work.

## Implementation approach

1. Preserve the visual prototype by keeping the existing components and styles in place where possible.
2. Extract shared event UI and admin UI from `src/app/App.tsx` into routeable page modules without redesigning the screens.
3. Add Supabase client setup using only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Add typed service modules for auth, events, and storage.
5. Add database and storage SQL setup files with RLS and private audio guidance.
6. Replace the query-string admin switch with React Router routes:
   - `/` for the public teaser page
   - `/admin` for the protected admin page
   - `/login` for authentication
7. Persist event drafts and state transitions in Supabase instead of local-only React state.
8. Upload selected files to Supabase Storage and store storage paths in the event record.
9. Use public image URLs for image buckets and signed URLs for private audio.
10. Add realtime event subscription with periodic fallback refetches for the public page.
11. Add loading, success, validation, and error states while preserving the existing visual language.
12. Add documentation, setup checklist, and security notes.
13. Run `npm install` and `npm run build`; fix Vite/build errors.
14. Make small logical commits after major phases.

## Follow-up improvements applied

- Fixed the admin start-time timezone bug by formatting `datetime-local` values from local browser date parts instead of slicing UTC ISO strings.
- Kept Supabase event timestamps stored as UTC and converted local admin input back to UTC on save.
- Added `supabase/chat-schema.sql` for moderated chat messages with RLS.
- Added realtime chat hooks and services for public approved chat history and owner-only moderation.
- Added admin Chat tab moderation actions and public live/finished chat views.

## Public design restoration notes

- Restored the original Figma-generated public visual structure from the pre-integration `src/app/App.tsx`: black full-screen background, CRT overlay, pixel typography, large centered countdown, centered artwork, neon-green corner treatment, bouncing artist image, and compact right/bottom status panel.
- Kept the restored visual components wired to Supabase-backed event data, storage public image URLs, and private signed audio URLs.
- Moved public chat out of the main teaser column into a neon slide-out drawer opened from the status panel, preserving the original teaser layout while keeping approved chat history and visitor submission available.
- Verified by build that desktop/mobile responsive constraints remain CSS-driven through the original clamp/max viewport sizing.

## Automatic timing implementation

- `starts_at` is the timestamp when an event becomes live.
- `ends_at` is the authoritative Event End Date and Time, and it is edited directly in the admin form.
- `duration_hours` remains only as a legacy compatibility column for older deployments; `supabase/event-end-times-migration.sql` backfills `ends_at` once from `starts_at + duration_hours`.
- `Start Event` does not rewrite timestamps. It sets the event to `upcoming` when the configured start is still in the future, or `live` when the configured start has already been reached and the end is still in the future.
- Upcoming public countdowns target `starts_at`.
- Live public countdowns target `ends_at`.
- `supabase/event-status-cron.sql` creates `public.update_scheduled_event_statuses()` and schedules the `update-event-statuses` Supabase Cron job to run every minute.
- The cron job changes `upcoming` events to `live` when `starts_at <= now()` and changes `upcoming` or `live` events to `finished` when `ends_at <= now()`.
- Realtime on `public.events` delivers cron-driven status changes to open public/admin clients without a page refresh or Vercel redeployment.
- The public page includes a display-only effective-state fallback so it can visually show the live page between the selected start time and the next cron run. Anonymous clients never write status changes.
