# 06 Staff login (per-user authentication)

Skill: spec-driven-development. Status: specify + plan (this file), then implement, then converge notes at the bottom.

## Specify

**Problem.** Staff routes accept one shared bearer token, and the acting person is a name typed into the request body.
Anyone holding the token can claim to be any approver, so the two-person approval rule for social posts and the lead
audit trail are not enforceable.

**Solved means.**
1. Each staff member has their own account; the server, not the request body, decides who is acting.
2. Approving, rejecting, publishing and platform consent require an `approver` or `admin` account; user management requires `admin`.
3. A stolen or shared password can be cut off quickly: sessions expire, can be revoked, and a disabled account loses access at once.
4. Guessing passwords is slow and noisy: per-account lockout, per-IP rate limit, no account enumeration, auth events recorded.
5. No third-party identity provider is needed to start. The owner has not chosen one (checklist group G), so this must work
   alone and not block a later move to Google or Microsoft sign-in.

**Out of scope.** SSO/OAuth sign-in, MFA, self-service signup, password reset by email, browser cookies, a staff UI.
These are named open items, not silent omissions. MFA and SSO are the next step once an identity provider is chosen.

## Plan

- Mode switch `STAFF_AUTH_MODE`: `shared` (default, today's behavior, kept so nothing breaks) or `users`.
  In `users` mode the shared token is rejected on every staff route. `STAFF_API_TOKEN` is required only in `shared` mode.
- Tables (migration 006): `staff_users` (unique lowercase email, role, scrypt hash, disabled, lockout counters),
  `staff_sessions` (SHA-256 of the token only, expiry, revoked), `staff_auth_events` (append-only).
- Passwords: scrypt (node:crypto, no new dependency), per-hash parameters stored in the hash string, 12 to 128 characters.
  Unknown and wrong-password logins take the same path (dummy hash verify) and return the same 401.
- Sessions: 32 random bytes as a bearer token, 12 h absolute and 60 min idle lifetime, revoked on logout, password change
  (others), reset and disable. Bearer tokens, not cookies, so there is no CSRF surface. The CORS allowlist still does not
  allow the Authorization header cross-origin.
- Lockout: 5 consecutive failures lock the account for 15 minutes; a locked account gets the same generic 401.
- Actor binding: in `users` mode the actor is `{type:"user", id:<email>}` from the session. A body `actor` is optional;
  if present and different it is refused with 403. Agents cannot act through a staff session.
- Roles: `staff` (leads, drafts, submit), `approver` (adds approve, reject, publish, connections), `admin` (adds user management).
- Routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/staff/me`, `POST /api/staff/password`,
  admin: `GET/POST /api/staff/users`, `POST /api/staff/users/:id/disable`.
- Bootstrap: `node src/staff-cli.mjs create-user <email> <role> <name>` with the password in `STAFF_NEW_PASSWORD`
  (never on the command line). Also `set-password`, `disable`, `list`.

## Tasks

1. Migration 006. 2. `auth.mjs` (hashing, sessions, guard, actor, roles). 3. Auth routes. 4. Wire server, social routes,
lead transition. 5. Config and startup warnings. 6. CLI. 7. Tests, mutation checks, real-process smoke. 8. Docs.

## Converge (2026-11-22)

Checked against the "solved means" list:
1. Per-user identity: done. In users mode the actor is the session's email; a different claimed actor is 403; agent actors cannot act through a staff session. Verified by tests and a real-process run over the Postgres wire protocol.
2. Roles: done. Approve, reject, publish and platform consent need approver or admin; user management needs admin. Mutation checks: removing the role gate, the actor check, either expiry, lockout, the disabled check, session revocation on reset, and the approve gate each make a test fail. Two mutations first survived (disabled check, approve gate); isolating tests were added and now catch them.
3. Cut-off: done. Logout, disable, password change (others) and reset revoke sessions; sessions expire.
4. Guessing: done. Lockout, per-IP rate limit (10 per minute), identical failure answers, append-only auth events.
5. No IdP needed: done; nothing here blocks adding SSO later.

Tests: 292 API tests pass (20 new). 

Known gaps, stated: no MFA; no SSO; no password reset by email; the first admin must be created from the server shell; shared mode is still the default (switching is one env var, but it is a deliberate step, not automatic); an admin can reset any password, including another admin's; staff-created leads still record the intake actor rather than the staff user; login rate limit is per IP behind TRUST_PROXY=1 only if the proxy is trusted; no staff UI exists, so users call the API directly; sessions live in Postgres and are not cleaned up after expiry (harmless, growth is slow).
