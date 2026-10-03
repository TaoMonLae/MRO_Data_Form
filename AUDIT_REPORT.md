# MRO Registry code, security and UX audit

Date: 3 October 2026. Changes are in the local workspace; they have not been deployed. Existing public-page, legacy-server, CSS and Threads edits were preserved. Testing used synthetic records in a separate temporary PostgreSQL instance, not the application database.

## Scope and outcome

Reviewed the active Express API, PostgreSQL schema and migration/admin scripts, React routes and account workflows, upload/import/export/print paths, legacy entrypoints, dependency lockfile and production configuration. The unrelated untracked `rtf` package and ZIP were left alone. This is a source review and local regression exercise, not a penetration-test certification or a review of live hosting/network configuration.

## Security fixes

| Priority | Verified issue | Implemented correction |
| --- | --- | --- |
| Critical | Member photos were public through `/uploads` and `/assets/uploads`. | Require sign-in, completed password setup and member-view permission; allow only explicit public brand files plus built assets; disable caching of private responses. |
| High | Cookie-authenticated mutations had no explicit CSRF check. | Require a custom same-origin header, reject cross-site/foreign-origin requests, document proxy origin configuration. |
| High | Password checks blocked the event loop and login attempts were unthrottled. | Asynchronous scrypt, bounded per-IP/account throttles, input validation before limiter storage, generic login errors and dummy verification for unknown users. |
| High | Concurrent account changes could bypass last-admin/session protections. | Serialize account changes and administrator recovery, recheck actor/session permissions under the lock, protect self/last admin and revoke sessions on role change/deactivation/reset. Login rechecks credentials under the same lock before issuing a session. |
| High | PostgreSQL TLS explicitly disabled certificate verification. | Enforce certificate and hostname verification, including URL SSL overrides. |
| High | Retired `server.js` could launch an HTTP service outside the active registry’s controls. | Refuse legacy startup while preserving its source; document `npm start` as the supported entrypoint. |
| High | Upload replacement could rename the old image over the new one, overwrite another member’s photo on an insert conflict, or restore a deleted path after a concurrent edit. | Validate signatures, write unique files, lock member rows during swaps/deletion and clean up staged files on failure. |
| Medium | ZIP decompression trusted size metadata before allocating buffers. | Bound each decompressed stream and enforce an aggregate actual-byte ceiling in addition to archive metadata limits. |
| Medium | Data Management Staff could see finance/HR/account details through the activity log. | Scope their full and dashboard activity feeds to registry events and omit IP addresses. Team attendance details require HR-view access. |
| Medium | Sensitive responses lacked cache controls and access logs retained query strings. | Add private/no-store behavior, query-free logs, CSP, framing/content-type/referrer controls and production HSTS. |
| Medium | PDF generation disabled Chromium’s sandbox and had no concurrency cap. | Keep the sandbox enabled and limit concurrent print jobs to two per process. |
| Medium | OAuth files could be committed or created with broad file permissions. | Ignore token/credential files and write saved tokens with owner-only permissions. |

Security approach checked against [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) and [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Data and workflow fixes

- Concurrent clock-in/out requests now permit one successful state transition and return a conflict for duplicates instead of overwriting the recorded time.
- Finance workbook imports preserve explicit zero net amounts; only missing amounts are calculated. Numeric parsing rejects malformed values instead of silently converting `1e3` to `13` or invalid text to zero. Card counts reject fractions, negatives and overflow.
- Calendar validation rejects impossible dates. Finance/carding creation requires a valid date; member writes reject invalid supplied dates. Import rows with an invalid new date no longer inherit the previous date.
- Database calculations and fresh frontend defaults use Kuala Lumpur time. Completed attendance displays “Shift complete”; long-open pages refresh across office-day rollover. Removed a hardcoded weekday.
- SQLite migration preserves inactive, deleted and password-change states. Duplicate/malformed rows roll back the import instead of being silently lost. Startup and administrator recovery are serialized; recovery revokes existing sessions atomically.
- Idle PostgreSQL connection failures and rollback failures are handled without an unhandled process crash or double client release.

## Users, roles and UI/UX

The staff directory now has name/email search, role/status filters, counts, mobile account rows and explicit pending-password states. The API supplies role permissions and per-account capabilities. Account dialogs explain access before saving, show protected-action reasons, guard against duplicate submissions and retain inline errors. Administrators can issue a temporary password while ending the target’s sessions. Deletion requires server-validated email confirmation and preserves historical attendance.

Native dialogs contain keyboard focus, make background content inert, support Escape and restore focus. Mobile navigation gets the same keyboard protections. Stale search/period responses are ignored; expired sessions return to sign-in. Decorative Threads respects reduced motion and degrades safely when WebGL is unavailable.

Research and the reference lock are in [UI_AUDIT.md](UI_AUDIT.md), including inspected [Mobbin Customer.io](https://mobbin.com/screens/06b14703-2bc0-40a8-8627-86bed102ce2f), [Refero Fingerprint](https://refero.design/pages/936c3653-4aaf-4219-b990-502d0f01644d), and [React Bits Pro public application UI catalog](https://pro.reactbits.dev/docs/app-ui) references. Existing MRO colors and layout remain the visual foundation. No premium source code was copied.

## Verification

- Final isolated test suite: **36 passed, 0 failed, 0 skipped**, including database/migration integration, role matrix, CSRF, session revocation, last-admin concurrency, private photos, upload conflicts, scoped audit logs, attendance concurrency and sandboxed PDF output. [Test output](audit-artifacts/test-results.txt).
- Production client build and `git diff --check` passed.
- Approved npm audit: **0 known vulnerabilities**, reduced from 11 initially reported. Compatible lockfile updates, removal of the retired mail dependency and narrowly scoped UUID overrides were applied; workbook import compatibility was exercised. [Audit JSON](audit-artifacts/npm-audit.json). The UUID override uses the upstream [11.1.1 security backport](https://github.com/uuidjs/uuid/releases/tag/v11.1.1).
- Browser checks at desktop and 390 × 844: production sign-in and asset/CSP compatibility, staff search, role/status controls, protected accounts, add-user dialog, mobile layout, Escape/focus restoration and mobile navigation. No captured console warnings/errors on the production sign-in/staff screens. These are focused checks, not a complete WCAG conformance audit.
- [Desktop screenshot](audit-artifacts/users-desktop.jpg) and [mobile screenshot](audit-artifacts/users-mobile.jpg) contain synthetic audit accounts only.

## Remaining work and deployment considerations

1. **Shared throttling and MFA:** the new throttles and print cap are per-process. Use shared gateway/store enforcement before scaling to multiple instances. MFA, self-service recovery and stronger admin reauthentication are not implemented.
2. **Private durable storage:** files still live on local disk. Do not expose `public/uploads` with a separate web server; use private durable storage and tested encrypted backups for production/multi-instance deployment. A process crash between filesystem and database operations can still leave an orphan file.
3. **Atomic audit durability:** many existing business/account audit inserts remain separate from the main transaction. A database failure between commit and logging can leave a missing event; moving all mutations and their audit records into one transaction is follow-up work. Member deletion and administrator recovery already log transactionally.
4. **Import resource isolation:** uploaded workbooks are size-limited but parsed in process. Large/compressed spreadsheets still warrant a dedicated worker with CPU/memory limits and broader adversarial-file testing.
5. **Scale and scope:** member/finance/audit list endpoints still use bounded fixed result limits rather than full pagination. More granular custom roles, archival/retention policies and live network/backups/security review need product/deployment decisions.

Production must use HTTPS and a unique bootstrap password. Set `APP_ORIGIN` correctly behind a proxy and trust only that proxy. Certificate verification may require the provider’s CA via `sslrootcert`. Restart the supported server to apply backend changes; no existing running application instance was intentionally restarted or deployed by this audit.
