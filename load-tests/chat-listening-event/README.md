# Live listening event load tests

This suite models the current public listening-event implementation with k6. It is intentionally guarded so large or write-heavy tests do not run accidentally.

## Architecture discovered

- App framework: Vite + React, not Next.js. Routes are client-side React Router routes: `/`, `/login`, `/admin`.
- Package manager: `pnpm@11.7.0`.
- Available app scripts before this suite: `dev`, `build`.
- Supabase client: `@supabase/supabase-js` using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Public event load: direct `events` table select through `getCurrentPublicEvent`.
- Public event Realtime: Supabase Postgres Changes channel `public-events`, plus a 60-second fallback refetch.
- Public chat identity: `join_event_chat(p_event_id uuid, p_session_id uuid)`.
- Visitor submission RPC: `submit_chat_message(p_event_id uuid, p_participant_id uuid, p_session_id uuid, p_body text, p_client_token uuid)`.
- Public visitor delta RPC: `get_visitor_visible_chat_message_delta(p_event_id uuid, p_participant_id uuid, p_session_id uuid, p_after_published_at timestamptz, p_after_id uuid, p_after_public_updated_at timestamptz, p_after_public_updated_id uuid, p_after_private_updated_at timestamptz, p_after_private_id uuid, p_limit integer)`.
- Listener count RPC: `get_event_listener_count(p_event_id uuid)`.
- Public chat Realtime: Supabase Postgres Changes on `chat_messages` filtered by `event_id`, followed by debounced cursor-delta fetches and a slower cutoff-aware safety poll.
- Audio sync: client-side time math against event `starts_at`; no heartbeat endpoint was found. Live audio URL uses Supabase Storage signed URL creation. Large chat tests do not download the full audio asset by default.
- Queue worker: `process_chat_publish_queue(p_event_id uuid default null)` calls `process_chat_auto_publish_queue(p_event_id uuid default null)`.
- Cron heartbeat: one `process-chat-publish-queue` job at `3 seconds`.
- Queue timing: event fields include `next_auto_publish_at`, `last_auto_published_at`, `current_queue_band`, `last_calculated_delay_ms`, `last_release_size`, `recent_fan_publish_count`, `publication_budget_per_minute`, and `scheduler_version`.
- Queue lock: event-scoped `pg_try_advisory_xact_lock(hashtext('chat-auto-publish:' || event_id))`.

## Tool choice

k6 is used because it is designed for high-concurrency HTTP load, supports thresholds that exit nonzero, emits machine-readable summaries, and can model many virtual listeners without changing the app. The primary scenarios exercise the real Supabase REST/RPC paths. Supabase Realtime WebSocket protocol simulation is not implemented in this first suite; the suite models the app's cutoff-aware cursor delta fetch path that exists as the fallback/reconciliation behavior.

## Safety

The suite refuses risky runs unless explicit environment variables are present.

Required for all scenarios:

```sh
LOAD_TEST_BASE_URL
LOAD_TEST_SUPABASE_URL
LOAD_TEST_SUPABASE_ANON_KEY
LOAD_TEST_EVENT_ID
LOAD_TEST_ENVIRONMENT
LOAD_TEST_AUTH_MODE
```

Required for scenarios that write chat data or run large tests:

```sh
LOAD_TEST_WRITE_ENABLED=true
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST
```

Production-like targets are refused unless the scenario explicitly allows production and you also set:

```sh
LOAD_TEST_PRODUCTION_OVERRIDE=AUTHORIZED_PRODUCTION_LOAD_TEST
```

Do not run production tests unless the production base URL, test window, Supabase usage limits, and Vercel usage limits are explicitly approved.

## Setup

Install k6 outside the app dependencies:

```sh
brew install k6
```

Prepare local environment variables without committing secrets:

```sh
cp load-tests/chat-listening-event/.env.example load-tests/chat-listening-event/.env.local
```

Load variables in your shell, or use your preferred secret manager. Do not commit `.env.local`.

Run a dry check:

```sh
pnpm run loadtest:dry-run
```

## Scenarios

Smoke test, 10 listeners for 5 minutes, includes legal submissions and sender-private visibility checks:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
pnpm run loadtest:smoke
```

Ramp test through 500, 2,500, 5,000, and 10,000 listeners:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=10000 \
pnpm run loadtest:ramp
```

Passive 10k listener test, no chat writes:

```sh
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=10000 \
pnpm run loadtest:passive-10k
```

Normal mixed 10k listener test:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=10000 \
pnpm run loadtest:mixed-10k
```

Peak-message 10k test:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=10000 \
LOAD_TEST_PEAK_WINDOW_SECONDS=30 \
pnpm run loadtest:peak-10k
```

Rate-limit enforcement test:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
pnpm run loadtest:rate-limit
```

Queue growth and drain:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=100 \
LOAD_TEST_DURATION=10m \
pnpm run loadtest:queue
```

Scheduler concurrency, staging only. This requires an access token that can invoke the worker. Normal visitor roles should not be able to do this:

```sh
LOAD_TEST_AUTH_MODE=service \
LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY=... \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_WORKER_INVOCATION_ENABLED=true \
pnpm run loadtest:scheduler-concurrency
```

Pause/resume, staging only with an authorized event owner token:

```sh
LOAD_TEST_AUTH_MODE=authenticated \
LOAD_TEST_SUPABASE_ACCESS_TOKEN=... \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_ADMIN_WRITE_ENABLED=true \
pnpm run loadtest:pause-resume
```

Short soak:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=1000 \
LOAD_TEST_DURATION=60m \
pnpm run loadtest:soak-short
```

Eight-hour soak profile, do not run casually:

```sh
LOAD_TEST_WRITE_ENABLED=true \
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST \
LOAD_TEST_MAX_VUS=10000 \
pnpm run loadtest:soak-8h
```

## Listener model

Each virtual listener:

1. Loads the public page once when enabled.
2. Creates a unique anonymous session ID.
3. Calls the real `join_event_chat` RPC.
4. Keeps participant ID, session ID, display name, and `joined_at`.
5. Fetches cutoff-aware visible message deltas through `get_visitor_visible_chat_message_delta`.
6. Refreshes message deltas approximately every heartbeat interval.
7. Refreshes cumulative listener count periodically.
8. Optionally submits legal synthetic messages through the secure five-argument `submit_chat_message` RPC.
9. Keeps per-VU seen-message state to detect duplicate public delivery.

Default activity distribution:

- 70% passive
- 20% light chatters
- 8% active chatters
- 2% peak chatters

Synthetic messages include `LOAD_TEST_RUN_ID` and unique suffixes to avoid accidental duplicate detection.

## Outputs

k6 writes:

- console summary;
- JSON summary under `load-tests/chat-listening-event/results/`;
- CSV metric summary under `load-tests/chat-listening-event/results/`.

Use k6's built-in JSON time-series output when needed:

```sh
k6 run --summary-export load-tests/chat-listening-event/results/summary.json \
  load-tests/chat-listening-event/scenarios/smoke.js
```

## Provisioning utility

Provisioning uses the real public join RPC:

```sh
node load-tests/chat-listening-event/tools/provision-participants.mjs --count 50 --out load-tests/chat-listening-event/results/participants.json
```

For more than 100 participants, set:

```sh
LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST
```

The output contains session IDs. Keep it local.

## Cleanup utility

Cleanup deletes only synthetic `chat_messages` for the configured `LOAD_TEST_RUN_ID` and event. It requires a service-role key and explicit confirmation:

```sh
LOAD_TEST_SUPABASE_SERVICE_ROLE_KEY=... \
LOAD_TEST_CLEANUP_CONFIRMED=DELETE_SYNTHETIC_LOAD_TEST_MESSAGES \
node load-tests/chat-listening-event/tools/cleanup-test-messages.mjs
```

Participant rows are intentionally left intact because they are listener analytics and cannot safely be distinguished from real generated identities after the fact.

## Database diagnostics

Use `sql/diagnostics.sql` in staging to inspect:

- active cron jobs;
- event scheduler state;
- queue depth;
- oldest queued age;
- recent publication counts;
- publication spacing;
- duplicate auto-approval audits;
- index usage;
- deadlocks and connection utilization.

`EXPLAIN (ANALYZE, BUFFERS)` snippets are included but commented out because they execute the query.

## Known limitations

- This repo is Vite + React, not Next.js.
- Supabase Realtime WebSocket protocol is not simulated in this first suite. The app's cutoff-aware cursor-delta fallback path is simulated for every joined listener.
- The suite does not prove 10,000-listener capacity by existing. Capacity requires measured staging results.
- Full audio asset download is disabled by default to avoid large bandwidth costs.
- Admin pause/resume and worker concurrency tests require staging credentials and explicit opt-in.
