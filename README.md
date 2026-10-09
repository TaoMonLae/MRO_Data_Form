# MRO Registry

React 19 + Node/Express operations workspace for Mon Refugee Organization member records, finance tracking, HR, staff access, attendance, KPI reporting and A4 registration-request printing.

## Requirements

- Node.js 20 or newer
- PostgreSQL 16 or newer
- Chromium available to Puppeteer for PDF generation

## Local setup

1. Install packages:

   ```bash
   npm install
   ```

2. Install and start PostgreSQL directly on your computer.

   On macOS with Homebrew:

   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   ```

   On Ubuntu or Debian:

   ```bash
   sudo apt install postgresql postgresql-contrib
   sudo systemctl enable --now postgresql
   ```

3. Create the application database and database user:

   ```bash
   createuser --pwprompt mro
   createdb --owner=mro mro_registry
   ```

4. Create the environment file:

   ```bash
   cp .env.example .env
   ```

   Set the password in `DATABASE_URL` to the password entered for the `mro` database user.

5. If you have data in the previous `submissions.db`, migrate it once into the empty PostgreSQL database:

   ```bash
   npm run db:migrate:sqlite
   ```

6. Create or refresh the administrator configured in `.env`:

   ```bash
   npm run admin:ensure
   ```

   This is safe to run after migration. It resets the configured administrator's password, revokes all of that account's sessions, and records the recovery in the audit log. The administrator must replace this temporary password at the next sign-in. Member records and other staff accounts are preserved.

7. Run the React client and Node API:

   ```bash
   npm run dev
   ```

Open `http://localhost:5173` during development. The Vite server proxies API and asset requests to the Node server on port 3000.

## Office location lock for attendance

The initial office zone is enabled for **68, Jalan Landak, Pudu, 55100 Kuala Lumpur** with a 150-metre radius. An Admin can change the address, coordinates, radius, maximum GPS uncertainty and reading age from **Office settings**. The configuration is stored in PostgreSQL and every clock action is checked again by the server.

Staff first press **Verify office location**. Only after the device is inside the office zone does the Clock in or Clock out button become available. A fresh precise-location reading is taken again when the clock action is submitted. The app does not continuously track staff.

For local testing, `localhost` is accepted by browsers. A hosted installation must use HTTPS for browser geolocation. Allow **precise location** when the browser asks. Existing attendance records remain readable and indicate when no location proof was recorded.

## Member and photo migration

Member imports use a review-first workflow. Choose an Excel or CSV file from **Member records**, review rows detected across suitable worksheets, manually select the rows to include, then confirm. Missing MRO Status numbers, missing names, duplicate workbook rows and records already in PostgreSQL are marked and left unchecked. Preview batches expire after 24 hours and do not alter member data until confirmed.

For bulk photos, create a ZIP containing JPG, JPEG or PNG files named exactly with the member’s MRO Status number, for example `53570.jpg`. Folder names inside the ZIP are ignored. The server validates image signatures, matches each filename to a member, stores matched photos in the private application upload area and reports unmatched, invalid or oversized files. Archives may contain up to 20,000 files; each photo is limited to 4 MB.

Forms are printed directly from the print icon on each Member records row, so there is no separate Form Printing navigation item.
The A4 form prints the saved MRO card number without its `MRO-` prefix in the title's right box and the Kuala Lumpur print date in `mm/dd/yyyy` at the upper left. Optional phone, document and family rows follow the saved member details. Save edits before using **Preview saved form** in the member drawer. See `PRINT_UI_AUDIT.md` for the scoped print audit and verification.

All user-facing data dates use `dd-mm-yyyy`. PostgreSQL and browser date controls continue to use ISO `yyyy-mm-dd` internally so sorting, validation and storage remain reliable.

Administrators can permanently delete a member from the row actions or member drawer. Deletion requires typing the member’s MRO Status number and removes both the PostgreSQL record and its managed uploaded photo. The audit log retains only a minimal deletion event without copying the member’s name or reference into the event detail.

## Daily carding and expenses

Card Printing Staff, Finance Officers, the Chair Person and Administrators can use **Daily carding**. It records service type, paid and unpaid card counts, rate, other income, expenses, payment method and notes. Monthly totals show paid cards, unpaid cards, expenses and net position.

`MRO_Carding_2026_Updated.xlsx` can be review-imported from this page. The importer reads completed rows in monthly `*_Daily` sheets, shows the source sheet and row, and imports only the rows selected by the user. Source keys prevent the same workbook row from being added twice. The existing Finance records importer continues to read completed `*_BankedIn` payment rows.

## Office workbook and access roles

Finance Officers, the Chair Person and Administrators can open **Finance records** and import `MRO_Carding_2026_Updated.xlsx`. The importer reads each monthly `*_BankedIn` sheet, keeps the payment date, Concern Person, Concern Person’s number, amount, deduction, net received and notes, and skips duplicates. Because the workbook does not contain payment methods or reliable payment statuses, those values are saved as **Not recorded** for staff to review instead of being guessed.

The available roles are Admin, Chair Person, Secretary, HR, Card Printing Staff, Data Management Staff and Finance Officer. Secretary access is read/print only for member records. HR manages employment profiles such as full-time, part-time, volunteer and contract staff. Admin and Chair Person can access the organization KPI dashboard. Every account created with a temporary password is held at a mandatory password-change screen on first sign-in. Signed-in staff can later update their own password from **Profile & access**; the current session stays active and other sessions are ended. Administrators can edit a staff member’s name, email, role and active status, or delete staff access without erasing historical attendance or audit records. Deactivation immediately ends that account’s sessions; the signed-in account and the last active administrator remain protected.

## Offline field registration

Staff with permission to edit member records can open **Offline registrations** from the member page. While online, each staff member prepares an encrypted vault on the device with an offline passphrase of at least 16 characters. After the page reports that offline access is ready, they can open `/offline` without internet and save new member registrations without photos. Existing records, photos, printing and other staff operations still require the server.

The browser stores queued registrations encrypted with AES-GCM in IndexedDB. It stores no login token or passphrase. On a shared device, each staff account has a separate vault; staff should also use separate operating-system or browser profiles where possible. The offline passphrase cannot be recovered. Clearing browser data, losing the device, or forgetting the passphrase can destroy unsynced records. Account deactivation cannot revoke access to an already unlocked offline vault until that device reconnects; secure the device and its passphrase.

When the page is open, the vault is unlocked and the device reconnects, it attempts to sync automatically. The same authorized staff account must have a valid server session. Close the queue only after it reports zero pending records. Browser background sync is not guaranteed, so a closed page must be reopened and unlocked. A duplicate MRO status or reference number stays in the queue for review instead of being silently overwritten. The server uses each queued operation ID to make retries safe after an uncertain connection failure.

Offline access requires HTTPS (or localhost) and a browser that supports service workers, IndexedDB and Web Crypto. Test the workflow on each field device before relying on it. The service worker caches only the public app shell and assets; it does not cache API responses or member photos.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

The Express server serves the built React application and API from one Node.js process. PostgreSQL can run as a normal operating-system service on the server or through a managed PostgreSQL provider. Set a production `DATABASE_URL`, a strong initial administrator password and `DATABASE_SSL=true` when required by the provider. TLS connections enabled with `DATABASE_SSL=true` verify both the server certificate and hostname. If the provider uses a private certificate authority, add its CA file through the `sslrootcert` parameter in `DATABASE_URL`; certificate verification is never disabled by this setting. PostgreSQL sessions use `Asia/Kuala_Lumpur` so date and month boundaries agree with attendance and reports.

For a smaller production installation, install all dependencies, build the client, then remove development-only packages before starting the server:

```bash
npm ci
npm run build
npm prune --omit=dev
NODE_ENV=production npm start
```

Run `npm ci` again before the next build. The Google Sheets utility dependencies are development-only; the active server and built client do not load them.

The initial account variables are used only when the PostgreSQL `users` table is empty.

Use a unique initial password; no built-in password is supplied. When a reverse proxy terminates HTTPS, set `APP_ORIGIN` to the exact public origin (for example `https://registry.example.org`) and `TRUST_PROXY` only to the proxy's trusted address/subnet. The client sends `X-MRO-Request: 1` on mutations; other API clients must do the same. Cross-origin mutations are rejected. Production cookies require HTTPS. Chromium must run with its sandbox supported by the deployment environment.

`server.js` is a retired SQLite implementation and deliberately refuses to start. Use `npm start` exclusively. Member photos are served through authenticated `/uploads` requests; do not configure a reverse proxy or hosting service to expose `public/uploads` directly. Brand images and built JavaScript/CSS are the only public assets.

Login and password throttling is local to each Node process. Before running multiple instances, add shared rate limiting at the trusted gateway or in a shared store. Administrator password resets end the target's sessions and force a password change; role changes and deactivation also revoke sessions. Data Management Staff can view registry audit events only; account, HR and finance audit events remain with Admin and Chair Person.

## Verification

Run `npm test` for unit checks and `npm run build` for the client build. Integration tests are opt-in and require a disposable PostgreSQL database named `mro_test_*`:

```bash
MRO_TEST_DATABASE_URL=postgres://localhost/mro_test_audit MRO_TEST_PDF=true npm test
```

The API integration suite clears application tables in that **test database** and uses synthetic staff/member records. Never point it at an application database. The database migration suite uses and removes an isolated schema. `MRO_TEST_PDF=true` also verifies sandboxed Chromium PDF generation. See `AUDIT_REPORT.md` and `UI_AUDIT.md` for findings, design references, verification and remaining deployment work.

## PostgreSQL migration behavior

The migration copies users, member submissions, sessions, attendance and audit logs while preserving IDs, password hashes, soft-deletion state and password-change requirements. Legacy accounts without a password-change flag must update their password after migration. It normalizes member dates to PostgreSQL `DATE`, operational timestamps to `TIMESTAMPTZ`, family data to `JSONB`, and active flags to `BOOLEAN`. SQLite timestamps without a timezone are interpreted as UTC; displayed day/month/year timestamps and attendance times use Malaysia time.

For safety, migration locks the target tables and stops when the target PostgreSQL database already contains application data. Duplicate records, invalid dates or malformed family data stop the migration and roll back the imported rows so no source rows are silently discarded. Keep the original SQLite file as a read-only backup until record counts, login, member searches, attendance and PDF output have been verified.

Run `node --test tests/database.test.js` for database helper regressions. To include real PostgreSQL migration and administrator-recovery checks, set `MRO_TEST_DATABASE_URL` to a disposable test database and run `node --test tests/database*.test.js`. The integration test creates and removes its own uniquely named schema.

## Sensitive-data deployment checklist

- Keep PostgreSQL on a private network and require TLS.
- Enable encrypted backups and point-in-time recovery.
- Store member uploads on durable private object storage or a persistent encrypted volume before running multiple Node instances.
- Give the application a least-privilege PostgreSQL role.
- Rotate the initial password after staff accounts are created.
- Test database and photo restoration together.
