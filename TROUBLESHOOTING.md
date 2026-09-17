# Troubleshooting Guide

## "Complete Phase N before..." errors

Every phase's submit endpoint checks its prerequisites explicitly and names
the missing one (e.g. "Complete the Phase 1 Discovery assessment before
Index Design."). This isn't a bug - phases are intentionally sequential.
Go complete the named phase first.

## "Target database is not reachable" / adapter health check fails

1. Confirm the right `TARGET_*` block is set for that project's resolved
   platform (Oracle vs Postgres vs Milvus) - see `.env.example`.
2. Confirm network reachability from wherever the backend runs to that
   database (VPC/security group/firewall).
3. Confirm the credentials are current (not rotated on the target side
   since you configured them here).
4. This has never been exercised against a real instance in development -
   see `PRODUCTION_READINESS.md` §3.1 if you're hitting something
   unexpected; the adapter code paths are unit-tested against mocks, not a
   live server, so a genuinely new integration issue is plausible.

## `401 Unauthorized` on every request after working fine

Your JWT expired (`JWT_EXPIRES_IN`, default 8h) or `JWT_SECRET` was rotated
server-side (see `RUNBOOK.md` - this invalidates every existing token). Log
in again.

## `403 Forbidden` with a message naming a required role

You're authenticated but your role doesn't permit that action - viewers are
read-only; only admins can execute a real deployment. See `SECURITY.md` for
the full RBAC matrix. Ask an admin to change your role if you believe it's
wrong.

## `429 Too Many Requests`

You (or something using your account/IP) hit the rate limit -
`THROTTLE_LIMIT` requests per `THROTTLE_TTL_SECONDS` app-wide, or the
tighter fixed limits on `/auth/login` (10/min) and `/auth/register` (5/min).
Wait and retry; if this is a legitimate high-volume automation use case,
raise `THROTTLE_LIMIT` (see `DEPLOYMENT.md`).

## Ingestion run reports dead letters

Check `GET .../ingestion/runs/:runId/dead-letters` (or the frontend's "View
dead letters" button) for the reason per record:
- **"empty after cleaning"** - the source document had no real content;
  fix the input, there's nothing to retry.
- **"Embedding failed after N retries"** / **"Storage failed after N
  retries"** - transient (rate limit, network, target down) or persistent
  (bad credentials, schema mismatch). Fix the root cause, then use "Retry
  Dead Letters" - both of these categories captured the original text and
  are re-embeddable/re-storable.
- **"Invalid embedding vector: expected N dimensions, got M"** - the
  embedding model's output doesn't match the schema's vector dimension.
  This means Phase 2's chosen model and the schema it generated have drifted
  apart; re-run Phase 2 rather than retrying.

## `npm install` prints `install-scripts` warnings

This is npm's newer "allowScripts" gate blocking install scripts for
`@nestjs/core`, `bcrypt`, `oracledb`, and `protobufjs` by default. All four
were verified to work correctly without their install script in this
project's Thin-mode/pure-JS configuration - the warning is expected and
non-blocking, not a sign anything is broken. Run
`npm install-scripts ls` if you want to review it yourself.

## A backend test file mocking `oracledb` or `@zilliz/milvus2-sdk-node` behaves oddly

Both are globally auto-mocked for every test via `src/__mocks__/` (see the
comments there) to avoid an unparseable transitive ESM dependency the real
Milvus SDK pulls in under Jest. If you need real behavior from one of them
in a specific test, call `jest.unmock('oracledb')` (or the Milvus package)
at the top of that file - don't delete the global mock, or every other test
that merely imports `VectorAdapterFactory` for its type will break again.

## Frontend shows a blank page / network errors in the browser console

1. Is the backend actually running and reachable at the URL the frontend is
   configured to hit (`vite.config.ts`'s proxy in dev, or nginx's
   `proxy_pass` in the built container)?
2. Check `helmet()`/CORS: the backend only allows `FRONTEND_ORIGIN` (default
   `http://localhost:5173`) - if you're serving the frontend from a
   different origin, set that env var to match.

## `docker compose up` fails on the `app-db` health check

Postgres can take a few seconds to accept connections on first start; the
backend's `depends_on: condition: service_healthy` should wait for it
automatically. If it still fails, check for a port conflict on 5432 from
another local Postgres instance.
