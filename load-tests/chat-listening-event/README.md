# Controlled synchronized chat load tests

This suite evaluates the live event chat system at 100, 500, 1,000, 5,000, and 10,000 active users without changing application correctness semantics.

It creates test infrastructure only. Do not run these tests against production. Do not run high-load stages until the operator has reviewed Supabase/Vercel limits, supplied a dedicated staging target, and explicitly enabled the stage.

## Architecture Inspected

- App framework: Vite + React.
- Supabase client: `@supabase/supabase-js` using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Public chat identity RPC: `join_event_chat(p_event_id uuid, p_session_id uuid)`.
- Visitor submission RPC: `submit_chat_message(p_event_id uuid, p_participant_id uuid, p_session_id uuid, p_body text, p_client_token uuid)`.
- Visitor delta RPC: `get_visitor_visible_chat_message_delta(...)`.
- Chat delivery: Supabase Postgres Changes as a wake-up signal, followed by cursor-delta RPC recovery.
- Public cursor: `published_at + id`.
- Public update cursor: `updated_at + id`.
- Private sender cursor: `updated_at + id`.
- Visibility boundary: public rows must satisfy `published_at >= participant.joined_at`.
- Realtime setup in the app: subscribe, wait for `SUBSCRIBED`, fetch cursor deltas, coalesce wake-ups, poll as recovery, pause normal polling while hidden, recover on focus/pageshow/online/visible.
- Audio sync: client-side time math against event timestamps. Large chat tests do not download full audio by default.

## Tooling

Two harnesses are intentionally separated:

- k6 HTTP/RPC harness: database/RPC pressure, cursor-delta polling, submission, sender-private checks, joined_at boundary checks, degraded-Realtime recovery.
- Node Realtime harness: persistent Supabase Realtime channel subscriptions, subscription stability, wake-up fanout, reconnect storms, foreground recovery storms, scope cleanup.

HTTP-only results must not be interpreted as proof of Realtime connection capacity. Realtime capacity requires the Node harness or an equivalent WebSocket-capable tool.

## Safety Gates

All real stages require:

- `LOAD_TEST_ENVIRONMENT=staging` or `LOAD_TEST_ENVIRONMENT=load-test`
- `LOAD_TEST_TARGET_URL`
- `LOAD_TEST_BASE_URL`
- `LOAD_TEST_ALLOWED_HOST`
- `LOAD_TEST_SUPABASE_URL`
- `LOAD_TEST_SUPABASE_ANON_KEY`
- `LOAD_TEST_EVENT_ID`
- `LOAD_TEST_RUN_ID`
- `LOAD_TEST_CONFIRMED=I_UNDERSTAND_THIS_LOAD_TEST`
- `LOAD_TEST_PARTICIPANT_GENERATION_ENABLED=true`

Write scenarios also require:

- `LOAD_TEST_WRITE_ENABLED=true`

Controlled public-message publication additionally requires a staging event-owner token and user ID:

- `LOAD_TEST_ADMIN_PUBLICATION_ENABLED=true`
- `LOAD_TEST_SUPABASE_ACCESS_TOKEN`
- `LOAD_TEST_ADMIN_USER_ID`

5,000 and 10,000 user stages additionally require:

- `LOAD_TEST_CONFIRM_HIGH_LOAD=true`
- `LOAD_TEST_LOWER_STAGES_PASSED=true`
- command argument `--confirm-high-load`

The target hostname must exactly match `LOAD_TEST_ALLOWED_HOST`. Known production-like hosts are refused. Production SQL is never modified by this suite.

## Dry Run

Dry-run validates configuration and prints estimates without creating participants, opening Realtime channels, publishing messages, or sending RPCs.

```sh
pnpm load:test --stage 100 --dry-run
```

Dry-run output includes target host, Supabase project ref, stage, scenario, expected duration, estimated polling volume, expected Realtime connections, and thresholds.

## Stage Commands

Default scenario is `idle`.

```sh
pnpm load:test --stage 100
pnpm load:test --stage 500
pnpm load:test --stage 1000
pnpm load:test --stage 5000 --confirm-high-load
pnpm load:test --stage 10000 --confirm-high-load
```

Run a specific scenario:

```sh
pnpm load:test --stage 500 --scenario publication
pnpm load:test --stage 500 --scenario sender-private
pnpm load:test --stage 500 --scenario joined-boundary
pnpm load:test --stage 1000 --scenario reconnect
pnpm load:test --stage 1000 --scenario foreground
pnpm load:test --stage 1000 --scenario degraded-realtime
pnpm load:test --stage 1000 --scenario scope-switch
```

Setup/report/cleanup:

```sh
pnpm load:setup --stage 100 --scenario idle
pnpm load:report --run-id loadtest-2026-07-30-a
pnpm load:cleanup --run-id loadtest-2026-07-30-a
```

Cleanup deletes only synthetic `chat_messages` whose body contains the configured run ID and event ID. It requires a service-role key and `LOAD_TEST_CLEANUP_CONFIRMED=DELETE_SYNTHETIC_LOAD_TEST_MESSAGES`.

## Scenarios

### A. Idle connected clients

Measures active participants with Realtime subscriptions and fallback cursor recovery while no messages are published.

Stages: 100, 500, 1,000, 5,000, 10,000.

Metrics include subscription success, active connections, reconnects, delta RPCs/client/minute, zero-row delta responses, p50/p95/p99 RPC latency, errors, and timeouts.

### B. Controlled publication

Measures notification fanout and delta RPC amplification per public message.

Publication patterns to run manually in staging: one message every 10 seconds, every 5 seconds, every second, burst of 10, burst of 50.

Key metric: `delta_rpc_calls_per_public_message`.

### C. Queued sender-private reconciliation

Submits legal queued messages for a configured subset, verifies the sender sees the private row, verifies other participants cannot see it, and checks merge-by-ID after approval/publication during staged observation.

### D. joined_at boundary

Verifies no public message with `published_at < joined_at` is returned, including after refresh/reconnect and presentation metadata changes such as pin/highlight.

Any pre-join leak is an immediate failure.

### E. Reconnect storm

Node Realtime harness simulates jittered reconnects for 10%, 25%, 50%, or 100% cohorts. Configure jitter with `LOAD_TEST_RECOVERY_JITTER_MS`.

### F. Foreground recovery storm

Node Realtime harness simulates focus/pageshow/visibility recovery bursts. Use jitter values of 0ms, 100ms, 1s, and 3s for comparison.

### G. Realtime degradation

k6 harness measures bounded polling recovery when Realtime is unavailable or ignored. Polling cadence matches deployed application assumptions; do not shorten it just to pass tests.

### H. Scope switching

Node Realtime harness closes old channels during event/session changes and verifies stale responses are not applied.

## Ramp Profiles

Default stage profiles are in `config/stages.json`.

- 100: ramp 2m, hold 5m, ramp down 1m.
- 500: ramp 5m, hold 10m, ramp down 2m.
- 1,000: ramp 5m, hold 15m, ramp down 2m.
- 5,000: ramp 10m, short initial hold, requires high-load confirmation.
- 10,000: ramp 15m, short initial hold, requires high-load confirmation and previous-stage review.

Spike and soak profiles are available through existing k6 scenario files, but should be run only after lower stages pass.

## Metrics and Thresholds

Collected metrics include:

- attempted clients, connected clients, failed clients
- active Realtime subscriptions
- subscription setup and reconnect outcomes
- total delta RPC calls
- delta calls per second
- delta calls per client per minute
- delta calls per public message
- zero-row responses
- rows returned
- p50/p95/p99 duration
- 4xx, 429, 5xx, timeout counts
- accepted submissions
- intentional rate-limit failures
- unexpected submission failures
- sender-private visibility latency samples
- visibility leaks
- duplicate public deliveries
- pre-join visibility violations
- stale-scope incidents
- foreground and reconnect recoveries

Default abort/failure thresholds:

- connection success rate at least 99%
- HTTP/RPC error rate below 1%
- unauthorized visibility incidents equal 0
- duplicate public messages equal 0
- missing public messages equal 0 in correctness samples
- stale-scope incidents equal 0
- lower-stage p95 delta RPC latency below 1s
- lower-stage p99 delta RPC latency below 3s
- sustained error rate above 5% should abort manual progression

## Thundering Herd Analysis

Every stage estimates and measures:

- `delta_rpc_calls_per_public_message`
- `peak_delta_rpc_rps_after_publication`
- `zero_row_delta_responses`
- `delta_rows_returned`

Compare:

- immediate fetch by every client
- harness jitter 0-500ms
- harness jitter 0-1s
- harness jitter 0-3s
- coalesced recovery behavior

Do not change production jitter automatically. Test alternate jitter only in the harness or behind a staging-only flag.

## SQL and Dashboard Validation

Use `sql/diagnostics.sql` in staging only. It includes:

- cron job checks
- queue depth
- recent publications
- duplicate approval audit checks
- index usage
- lock/deadlock checks
- connection utilization
- commented `EXPLAIN (ANALYZE, BUFFERS)` snippets

Capture Supabase dashboard panels for database CPU, memory, connections, Realtime concurrent connections, Realtime messages per second, API errors, egress, and rate limits.

## Reports

Outputs:

- k6 JSON summary in `results/`
- k6 CSV summary in `results/`
- Realtime JSON/Markdown summary in `reports/`
- comparison Markdown from `pnpm load:report`

Report files should include run ID, commit hash if available, scenario, concurrency, duration, publication rate, polling cadence, Realtime health, pass/fail thresholds, latency percentiles, error rates, RPC calls/client, RPC calls/message, correctness incidents, observed bottleneck, Supabase dashboard observations, and recommendation for the next stage.

## Manual iPhone Safari Note

Protocol harnesses do not reproduce iOS Low Power Mode, Safari background throttling, or device rendering costs. Use a small manual device test alongside staging runs to record real foreground/background delivery behavior.

## Validation Without Running Load

Safe implementation checks:

```sh
pnpm load:unit
node scripts/check-load-tests.mjs
node scripts/check-event-timing.mjs
node scripts/check-chat-delta-cursors.mjs
pnpm run build
git diff --check
```

These commands do not run the 100-10,000 user stages.
