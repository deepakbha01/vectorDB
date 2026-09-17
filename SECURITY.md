# Security

## Authentication & session management

- JWT-based (`@nestjs/jwt`), passwords hashed with bcrypt (12 rounds).
- Token lifetime is configurable via `JWT_EXPIRES_IN` (default 8h). There is
  no server-side session store, so a token cannot be revoked before it
  expires - this is a deliberate, documented trade-off for simplicity. If
  you need revocation, add a refresh-token + denylist scheme before
  shortening `JWT_EXPIRES_IN` further won't be enough on its own.
- The app refuses to boot in `NODE_ENV=production` unless `JWT_SECRET` is
  set and at least 32 characters (`main.ts`, `requireProductionSecrets`).

## Authorization (RBAC)

- Three roles: `admin`, `architect`, `viewer` (`UserRole`).
- `RolesGuard` + `@Roles(...)` enforce this on every controller: viewers can
  read (`GET`) anything they have project access to, but every mutating
  endpoint (`POST`/`PATCH`) requires `admin` or `architect`.
- `deployment/execute` - the one endpoint that connects to and writes into a
  real target database - requires `admin` specifically.
- Project-level access is owner-or-admin (`ProjectsService.assertAccess`);
  there is no per-project collaborator/sharing model yet.

## Input validation

- Every request body is a `class-validator` DTO. The global `ValidationPipe`
  is configured with `whitelist: true, forbidNonWhitelisted: true`, so
  unexpected fields are rejected outright, not silently dropped or trusted.
- Every SQL/Milvus identifier that originates from user input (table names,
  collection names, metadata field names) is sanitized through
  `common/identifier-sanitizer.ts` before being interpolated into generated
  DDL or query text - this applies both when the DDL is only *displayed*
  (Phase 2/3 design output) and when it is actually *executed* against a
  real database (Phase 4+ adapters), since the same sanitizer is reused in
  both places.

## Secrets

- Nothing is hard-coded. Every credential (`JWT_SECRET`, `APP_DB_*`,
  `TARGET_*`, `OPENAI_API_KEY`) is read from the environment at the point of
  use; `.env.example` documents every one with no real value ever present.
- The audit log redacts sensitive fields (`password`, `token`, `accessToken`,
  `secret`, `apiKey`, `authorization`, case-insensitively, recursively
  through nested objects/arrays) before persisting request/response bodies -
  see `backend/src/audit/audit-summarize.ts`.

## Transport security

- TLS is expected to be terminated upstream (load balancer / ingress /
  reverse proxy) in any real deployment - this app does not terminate TLS
  itself. `helmet()` is applied for the usual defensive HTTP headers on the
  API; the frontend's nginx config adds `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`.
  `Strict-Transport-Security` is deliberately *not* set at the nginx layer,
  since this container serves plain HTTP and a false HSTS promise from an
  unencrypted origin is worse than no header at all - set it at whichever
  layer actually terminates TLS.

## Encryption at rest

- This application does not implement its own at-rest encryption for either
  its own metadata database or the target vector database - that is a
  managed-database-provider responsibility (e.g. RDS/Cloud SQL encrypted
  storage, Oracle TDE). Confirm it is enabled at that layer.

## Rate limiting

- App-wide: `@nestjs/throttler`, configurable via `THROTTLE_TTL_SECONDS` /
  `THROTTLE_LIMIT` (default 100 requests / 60s per client).
- `/auth/login` and `/auth/register` have their own fixed, tighter limits
  (10/min and 5/min respectively) independent of the app-wide config, since
  they are the classic brute-force/credential-stuffing/enumeration target.

## Auditability

- Every mutating request is persisted (`AuditLogEntry`): user, method, path,
  status code, duration, and redacted request/response summaries. See
  `backend/src/audit`. Query a project's trail via
  `GET /projects/:id/audit-log` or the frontend's Audit Log page.

## Dependency vulnerabilities

Current state (`npm audit`, backend, production dependencies only):

| Package | Severity | Why it's not yet fixed |
|---|---|---|
| `tar` (via `@mapbox/node-pre-gyp`, a build-time dep of `bcrypt`) | Critical | Fix requires a major bump; this package runs only during `npm install`, never at request-serving runtime |
| `js-yaml`, `lodash` (via `@nestjs/swagger`/`@nestjs/config`) | High | Fix requires `@nestjs/swagger@12` (breaking); deferred pending a real end-to-end test run |
| `multer`, `body-parser` (via `@nestjs/platform-express`) | High | This app has no file-upload endpoints (no `multer` usage at all); fix requires `@nestjs/platform-express@12` (breaking) |
| `qs` | Moderate | Transitive; fix requires the same major bump as above |
| `uuid` (via `@nestjs/typeorm`) | Moderate | This app's own direct `uuid` dependency was removed (unused - `crypto.randomUUID()` is used instead); the transitive one is internal to TypeORM/NestJS |

All were reviewed, none are reachable via an attacker-controlled code path
in this app's own routes today. Re-run `npm audit` after any dependency
bump and re-triage. `npm audit fix` (non-breaking) has already been applied;
`npm audit fix --force` has not, deliberately - see
`PRODUCTION_READINESS.md` §3.6.

## Reporting a vulnerability

This is a demonstration/reference project, not a maintained product with a
disclosed security contact. If you fork it for real use, replace this
section with your own reporting process before deploying.
