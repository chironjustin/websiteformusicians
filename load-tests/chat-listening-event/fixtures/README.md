# Load-test fixtures

Use this directory only for local fixture manifests generated for dedicated staging runs.

Rules:

- Every run must use a unique `LOAD_TEST_RUN_ID`.
- Use a dedicated staging/load-test event.
- Do not store production user data here.
- Do not commit generated participant manifests, Supabase tokens, session IDs, or reports containing secrets.
- Prefer names such as `loadtest-{runId}-vu-{number}` in synthetic messages.

