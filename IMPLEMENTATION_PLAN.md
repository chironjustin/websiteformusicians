# Supabase Integration Implementation Plan

## Phase 1 audit findings

- The app is a Vite + React + TypeScript project generated from Figma.
- The public teaser UI, admin dashboard, event setup controls, file selectors, chat, and event state preview are all currently implemented in `src/app/App.tsx`.
- `src/main.tsx` imports `./app/App.tsx`; there is no separate route tree yet.
- Routing is not configured with React Router. The admin dashboard is currently shown when the URL query string contains `?admin`; otherwise the public page renders.
- `react-router` is installed, but no router APIs are currently used. Because client-side routes are required for `/`, `/admin`, and `/login`, the Vercel SPA rewrite will be needed.
- Event information is stored only in local React state inside `App`. The initial event is hardcoded with title `Gravity`, empty file URLs, a start time three minutes in the future, and a twelve-hour duration.
- Mock/hardcoded behavior is used for event state, messages, uploads, and admin controls.
- `Start Now` and `End Now` currently mutate local `startTime` only. They do not persist anything and do not call a backend or trigger a Vercel redeploy.
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

## Automatic timing TODO

The client can safely display an upcoming event as live once `starts_at` is reached, but it must not be trusted to persist scheduled status transitions. Fully reliable automatic database status changes require a trusted scheduler, such as:

- Supabase scheduled Edge Functions
- Supabase Cron
- a scheduled Vercel Function
- another trusted backend scheduler

For this integration, the app will support manual `Start Now` and `End Now` actions from the authenticated admin dashboard without triggering Vercel redeployments.
