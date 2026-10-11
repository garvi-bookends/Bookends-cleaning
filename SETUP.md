# Bookends Cleaning — authentication setup

Written for: whoever deploys and maintains this app.

Login used to be checked in the browser against a password stored in plain
text in `localStorage`, which was also synced into the Supabase `bk_users`
table using the anon key held in the page. Every device could read everyone's
password.

Accounts now live in Postgres, passwords are stored only as bcrypt hashes,
and login happens on a Node/Express backend. The UI is unchanged apart from
the code that talks to the new API.

Cleaning tasks, expiry products and photos also go through this backend now
(`/api/sync`, `/api/photos`), so the page holds no database key at all. The
same code runs locally, on any Node host, or on **Vercel** — see
[section 10](#10-deploy-on-vercel--neon).

---

## 0. Two-role update (October 2026) — what to do when deploying it

The web app now has two roles. **Admin** covers Super Admin, Execution Head,
Assistant Execution Head, Admin, Head of Kitchen and Auditor (view only).
**Location Manager** covers manager and staff, limited to their own
restaurant. The pages are:

- **Admin:** Dashboard, Cleaning Task, Checklist, Labeling, and Settings, which
  holds the Audit Log and Wipe All Data.
- **Location Manager:** Cleaning Task, Checklist, Labeling, Expiry and Settings.

**Deploy steps**

1. `npm run migrate`. It adds `app_cleaning_tasks`, `app_checklist_items`,
   `app_labels`, `app_notifications`, `app_photos` and `app_settings`, and
   widens `app_admin_audit` into the full audit log. It is additive and safe to
   re-run.
2. Start the server. On the first API request two one-time fixes run:
   - the Lunch, Dinner and Closing checklists are seeded with the existing 24
     questions, all required, no photo;
   - existing expiry products (`bk_products`) are copied into labels, in the
     status they are already in, so no burst of notifications is sent.
3. **Scheduled reminders** (opens or closes in 5 minutes, label expiring or
   expired) come from `server/services/scheduler.js`.
   - **Long-running server** (`npm start`): runs every minute by itself.
   - **Vercel:** the scheduler also runs in the background whenever the app is
     in use. For reminders that arrive on time when nobody has the app open,
     call `GET /api/cron/tick` every minute with
     `Authorization: Bearer <CRON_SECRET>` from an external scheduler (Vercel
     Hobby crons can only run daily).

**Photos** for tasks, checklists and labels go to `POST /api/files`. Only
real JPEG or PNG files up to 2 MB are accepted, and each account can upload
300 an hour. Photos are stored in Postgres, or in Vercel Blob when
`BLOB_READ_WRITE_TOKEN` is set. They are only ever served through signed
links that expire after 6 hours, issued to someone allowed to see the record.

**Wipe All Data** (Super Admin, Execution Head, Assistant Execution Head,
Admin) needs the typed phrase and the admin's own password. It deletes tasks,
checklist submissions, labels, notifications and photos, plus the older synced
jobs and products. It keeps accounts, checklist items and the audit log. No
endpoint deletes audit history.

The endpoints used by the Flutter app (`/api/sync`, `/api/photos`,
`/api/checklist/*`, and `/api/checklists` with the old `answers` array) still
work as before.

---

## 1. Folder structure

```
maintain/
├── index.html                    the app (unchanged UI; auth + sync code rewired)
├── package.json
├── vercel.json                   Vercel: routing, security headers, daily cron
├── .vercelignore                 keeps .env files out of Vercel uploads
├── .env                          your secrets — NEVER commit (gitignored)
├── .env.example                  template to copy
├── .gitignore
├── api/
│   └── index.js                  Vercel function entry — exports server/app.js
├── scripts/
│   └── build.js                  `npm run build`: index.html -> public/, header check
├── public/                       the only folder Vercel publishes
└── server/
    ├── app.js                    Express app: headers, CORS, routes, static
    ├── server.js                 listen() + hourly cleanup (local / Render)
    ├── securityHeaders.js        CSP etc. — shared by helmet and vercel.json
    ├── config/
    │   └── env.js                loads + validates every environment variable
    ├── db/
    │   ├── pool.js               Postgres pool, query(), transaction()
    │   ├── bootstrap.sql         one-time: create the database + app role
    │   └── schema.sql            the tables (idempotent)
    ├── models/
    │   ├── userModel.js          accounts — the only file that reads a hash
    │   └── refreshTokenModel.js  revocable sessions
    ├── services/
    │   ├── passwordService.js    bcrypt hash / verify, strength policy
    │   ├── tokenService.js       JWT signing, refresh tokens, cookie options
    │   ├── authService.js        login, refresh, logout, password changes
    │   └── cleanupService.js     prunes expired sessions / rate limits / old audit
    ├── middleware/
    │   ├── requireAuth.js        "who is this?"  — protects routes
    │   ├── requireRole.js        "may they do this?" — admin-only routes
    │   ├── validate.js           request validation
    │   ├── rateLimit.js          per-IP throttling, counted in Postgres
    │   └── errorHandler.js       one place errors become JSON
    ├── routes/
    │   ├── authRoutes.js         /api/auth/*
    │   ├── userRoutes.js         /api/users/roster
    │   ├── adminRoutes.js        /api/admin/*
    │   ├── syncRoutes.js         /api/sync/tasks|products — per-kitchen access
    │   ├── photoRoutes.js        /api/photos — stores photos in Vercel Blob
    │   └── cronRoutes.js         /api/cron/cleanup — Vercel Cron only
    └── scripts/
        ├── migrate.js            applies schema.sql
        ├── seed.js               creates the starting roster
        ├── createUser.js         creates one user from the command line
        └── importSupabase.js     one-time copy of old Supabase data into Neon
```

---

## 2. Database setup

### 2.1 Which database

This machine runs a **second PostgreSQL 18 instance on port 5433**, separate
from the pre-installed `postgresql-x64-18` Windows service on 5432.

It exists because the service on 5432 needs its superuser password, which was
not to hand, and resetting that needs Windows administrator rights. This
instance needs neither — its data directory lives in your own user profile,
so `initdb` could create it as a normal user.

| | |
|---|---|
| Data directory | `C:\Users\bookends2\bookends-pgdata` |
| Port | `5433` |
| Superuser | `postgres` / `7990` |
| App role | `bookends_app` / `7990` |
| Database | `bookends` |
| Log | `C:\Users\bookends2\bookends-pgdata\server.log` |

**The service on 5432 was never touched** — no config edited, no password
changed. It is still there if you ever get its password.

Because this instance is not a Windows service, it does not start
automatically after a reboot:

```bash
npm run db:start     # start it
npm run db:status    # is it running?
npm run db:stop      # stop it
```

To move to a managed host (Supabase, Neon, RDS) later, put its URI in
`DATABASE_URL` and set `DATABASE_SSL=true`. Nothing else changes. On Supabase
use **Project Settings → Database → Connection string → URI** with the
**Session pooler** on port `5432`; the transaction pooler on `6543` does not
support prepared statements, which `pg` uses.

### 2.2 How the database and role were created

Already done — recorded here for rebuilding it elsewhere. Needs the postgres
password but **not** Windows administrator rights.

If you have a working server already, run
[server/db/bootstrap.sql](server/db/bootstrap.sql); its header has the pgAdmin
click-path. To create a fresh user-owned instance the way this one was made,
from `C:\Program Files\PostgreSQL\18\bin`:

```powershell
$bin  = "C:\Program Files\PostgreSQL\18\bin"
$data = "$env:USERPROFILE\bookends-pgdata"

# 1. a data directory you own, with the superuser password set from a file
"7990" | Out-File "$env:TEMP\pw.txt" -Encoding ascii -NoNewline
& "$bin\initdb.exe" -D $data -U postgres --pwfile="$env:TEMP\pw.txt" `
    --auth-host=scram-sha-256 --auth-local=trust -E UTF8
Remove-Item "$env:TEMP\pw.txt"

# 2. start it on a free port
& "$bin\pg_ctl.exe" -D $data -l "$data\server.log" -o "-p 5433" start

# 3. the database and the application role
$env:PGPASSWORD = "7990"
& "$bin\psql.exe" -U postgres -h 127.0.0.1 -p 5433 -d postgres `
    -c "CREATE ROLE bookends_app LOGIN PASSWORD '7990';" `
    -c "CREATE DATABASE bookends OWNER bookends_app;"

# 4. PostgreSQL 15+ needs this granted explicitly, ON THE NEW DATABASE
& "$bin\psql.exe" -U postgres -h 127.0.0.1 -p 5433 -d bookends `
    -c "GRANT ALL ON SCHEMA public TO bookends_app;" `
    -c "ALTER SCHEMA public OWNER TO bookends_app;"
```

Step 4 is not optional, and it must run against `bookends`, not `postgres`.
PostgreSQL 15 and later stopped letting ordinary users create objects in
`public`, so without it the migration stops with `permission denied for
schema public`.

The app connects as `bookends_app`, never as the superuser, so a leaked `.env`
reaches this one database and nothing else on the server.

To remove this instance entirely: `npm run db:stop`, then delete the data
directory. Nothing else on the machine is affected.

### 2.3 Create the tables

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# edit .env (see section 3)
npm run migrate
```

`migrate` creates four tables and prints what it made:

| Table | What it holds |
|---|---|
| `app_users` | profile + login bookkeeping: id, username, name, role, location, first-login status, last login, login count, creation date |
| `app_user_credentials` | the bcrypt hash, one row per user, plus failed-attempt counters |
| `app_refresh_tokens` | live sessions (hashed), so a session can be revoked |
| `app_login_audit` | every sign-in attempt, successful or not |

**Profiles and hashes are in separate tables on purpose.** Nothing that reads
a profile can accidentally select a password hash, so the roster endpoint
physically cannot leak one.

The migration also enables row-level security with **no policies** on all four
tables. That means the Supabase `anon` and `authenticated` roles — including
the key sitting in `index.html` — get zero access to them. The backend
connects as the table owner over a direct connection and bypasses RLS.

### 2.4 Create the first accounts

```bash
npm run seed
```

This recreates the roster the app used to seed locally (the Admin EXE Super Admin
and the eight location managers), with bcrypt hashes instead of plain text.
Everyone except the bootstrap admin gets `DEFAULT_PASSWORD` and must choose
their own on first sign-in. Re-running it never overwrites a password someone
has already changed.

`seed` refuses to run unless `SEED_ADMIN_PASSWORD` is set to something strong
and different from `DEFAULT_PASSWORD` — that account can create every other
user. Delete the variable from `.env` once you have signed in.

### 2.5 Retire the old plaintext table

Once you have signed in and the roster looks right, drop the old table. It
still contains everyone's old plaintext passwords and is readable by anything
holding the anon key.

```sql
drop table if exists bk_users;
```

(The statement is at the bottom of `server/db/schema.sql`, commented out.)
**Tell everyone to change their password**, since the old ones were exposed.

---

## 3. Environment variables

Copy `.env.example` to `.env` and fill it in. Nothing has a usable default;
the server refuses to start if a secret is missing, under 32 characters, or
still says `replace-me`.

Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | Notes |
|---|---|
| `DATABASE_URL` | see section 2.1 (local instance on port 5433); on Vercel, Neon's **pooled** URL |
| `DATABASE_SSL` | `false` for the local instance; `true` for any managed host |
| `DATABASE_SSL_NO_VERIFY` | leave unset — the database certificate is verified. `true` only for a host whose certificate chain Node does not trust |
| `DATABASE_POOL_MAX` | default `10`, or `1` on Vercel (many instances share Neon's pooler) |
| `JWT_SECRET` | signs access tokens |
| `JWT_SECRET_PREVIOUS` | only while rotating: the **old** `JWT_SECRET`, so tokens it signed keep working for their last 15 minutes. Remove afterwards |
| `REFRESH_TOKEN_SECRET` | must differ from `JWT_SECRET` |
| `CRON_SECRET` | Vercel only — at least 32 random characters; Vercel sends it to `/api/cron/cleanup` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store for photos; set automatically when you connect a Blob store. Without it photos stay on the device |
| `ACCESS_TOKEN_TTL` | default `15m`; refreshed silently, so short is fine |
| `REFRESH_TOKEN_TTL_DAYS` | default `30` — how long a phone stays signed in |
| `BCRYPT_ROUNDS` | default `12` |
| `DEFAULT_PASSWORD` | the starting password an admin hands out (`1234`) |
| `MIN_PASSWORD_LENGTH` | default `8`. Applies to passwords people choose; the shared starting password (`DEFAULT_PASSWORD`) is exempt because it must be changed at first sign-in |
| `MAX_FAILED_ATTEMPTS` / `LOCKOUT_MINUTES` | lockout after repeated wrong guesses |
| `CORS_ORIGINS` | leave **empty** when Express serves `index.html` (recommended) |
| `SEED_ADMIN_*` | used once by `npm run seed` |

`.env` is gitignored. Do not commit it, and set these as real environment
variables on your host rather than uploading the file.

---

## 4. Run it

```bash
npm run db:start   # only needed after a reboot — see section 2.1
npm start          # or: npm run dev   (restarts on change)
```

Then open `http://localhost:3000`. Express serves `index.html` and the API
from the same origin, which is why the refresh cookie works without any
cross-site configuration.

Other devices on the same Wi-Fi can use `http://<this PC's IP>:3000` (find
the IP with `ipconfig`) once Windows Firewall allows inbound TCP 3000. This
works because development sends no `upgrade-insecure-requests`; in production
(`NODE_ENV=production`) the app expects HTTPS and switches every request to
it, so a plain-http production server only works on `localhost`.

---

## 5. API endpoints

### Authentication — `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/login` | — | `{ uid, password }` → access token + user; sets the refresh cookie |
| POST | `/forgot` | — | "Forgot password?": `{ uid }` → puts a reset request on the Super Admin dashboard. Same reply whether or not the username exists |
| POST | `/register` | — | self sign-up: `{ name, uid, password, confirmPassword, loc }` → a **pending** account, no session |
| POST | `/refresh` | cookie | new access token; rotates the refresh token |
| POST | `/logout` | cookie | revokes this session |
| GET | `/me` | Bearer | the signed-in user's profile |
| POST | `/change-password` | Bearer | the user chooses their own password |

### Roster — `/api/users`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/roster` | Bearer | id, username, name, role, location — nothing else |

### Tasks, products, photos — `/api/sync`, `/api/photos`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sync/:kind?since=&after=` | Bearer | `kind` = `tasks` or `products`. Changed records, 300 at a time. Head-office roles see every kitchen; everyone else only their own |
| POST | `/api/sync/:kind` | Bearer | `{ rows: [{ id, loc, data }] }`, up to 200. Rows for another kitchen are skipped and listed in `rejected`. An older edit never replaces a newer one. Auditor: 403 |
| POST | `/api/photos?loc=` | Bearer | raw `image/jpeg` or `image/png` body, ≤ 1 MB → `{ url }`. Checked by file header, stored under a random name. Auditor: 403 |
| GET | `/api/cron/cleanup` | `CRON_SECRET` | daily cleanup, called by Vercel Cron only |

### Administration — `/api/admin` (exec / aexec / admin only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/users` | all accounts with their login info |
| POST | `/users` | **create a user** |
| GET | `/users/suggest-uid?name=` | propose a free login ID |
| PATCH | `/users/:id` | change name, role, location |
| POST | `/users/:id/approve` | **Super Admin only** — approve a self sign-up: `{ role, loc }` |
| POST | `/users/:id/reset-password` | set a new password, `{ password? }` — also clears any reset request |
| POST | `/users/:id/dismiss-reset` | **Super Admin only** — close a reset request without changing the password |
| DELETE | `/users/:id` | remove someone who has left |
| GET | `/login-audit?limit=` | recent sign-in attempts |

### Example: create a user

```bash
# 1. sign in as an admin
curl -s -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"uid":"adminexe","password":"your-admin-password"}'
# -> {"user":{...},"accessToken":"eyJ...","expiresIn":900,"mustChangePassword":false}

# 2. create the account
curl -s -X POST http://localhost:3000/api/admin/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer eyJ...' \
  -d '{"name":"Suresh Patel","role":"staff","loc":"SUR-PREP"}'
# -> { "user": { "id":"U-...","uid":"suresh","role":"staff","mustChange":true,
#                "firstLogin":true,"createdAt":1758... },
#      "initialPassword": "1234" }
```

`uid` is optional — omitted, the server derives it from the first name and
deduplicates. `password` is optional — omitted, `DEFAULT_PASSWORD` is used.
`initialPassword` is returned **once** so you can pass it on; it is stored
only as a hash and cannot be read back.

Or from the command line:

```bash
npm run create-user -- --name "Suresh Patel" --role staff --loc SUR-PREP
```

---

## 5a. Self sign-up

People can create their own account from the login screen: **New here? Create
your own account**. They choose their own name, username, kitchen and
password.

What they cannot choose is their access. The account is created as `staff`
and **pending**:

1. The person signs up. The password is bcrypt-hashed like any other; no
   session is issued.
2. Signing in with the right password says *"Your account is waiting for
   approval"*. With a wrong password it says the usual *"Invalid username or
   password"* — the approval message only goes to someone who knows the
   password, so it reveals nothing about which usernames exist.
3. The **Super Admin (adminexe)** sees *"N new accounts waiting for approval"*
   on his home screen, and opens **People, roles & passwords**. Sign-ups
   appear at the top under **Waiting for approval**, with the kitchen they
   said they work at pre-selected. He picks the role and kitchen and taps
   **✓**, or taps **✕** to reject (which deletes the account). Other admins
   see who is waiting but get no approve or reject buttons, and the server
   refuses them with 403 if they try the API directly.
4. The person signs in with the username and password they chose. They are
   **not** forced to change it, since they chose it themselves. They can still
   change it any time from **🔒 Change my password**.

### The Super Admin

Exactly one account, **adminexe**, holds the **Super Admin** role. It is the only
account that can approve or reject self sign-ups.

- **Only one can ever exist.** A unique index in the database refuses a second
  one, so this does not depend on the app getting every check right.
- **It cannot be given from the app.** No role dropdown offers it, and the API
  refuses `superadmin` when creating, editing or approving an account. It is set
  on the server:

  ```bash
  npm run set-superadmin -- adminexe
  ```

  Naming someone else steps the current Super Admin down to Execution Head in
  the same transaction.
- **Nobody else can take it over.** Other admins cannot reset, edit or delete
  the Super Admin account. Without that, an Execution Head could reset the Super Admin's
  password and sign in as him.
- **It cannot be removed by accident.** The Super Admin cannot change their
  own role from the app, so the system is never left with nobody to approve.
  adminexe changes their own password from **🔒 Change my password**.

### Super Admin dashboard and "Forgot password?"

adminexe's **Signed in** menu has **🛡️ Super Admin dashboard**. It shows:

- **Every account**: name, username, role, kitchen, and status (never signed
  in, last sign-in, waiting for approval).
- **Password reset requests**, at the top, from people who tapped **Forgot
  password?** on the login screen.
- **Sign-ups waiting for approval**, with a link to the approval screen.

**Passwords are not shown, because they cannot be.** Only a one-way bcrypt hash
is stored (requirement 3); there is no way back from the hash to the
password. Showing passwords would mean storing them readably again, which
is the problem this whole change removed. Instead, each row has **🔑 Set new
password**: adminexe types a temporary one (or leaves it blank for `1234`),
sees it once to hand over, and the person must choose their own at next
sign-in. They are signed out on every device at the same moment.

"Forgot password?" works without email or SMS, which this system does not
have: the person enters their username, and the request appears on adminexe's
dashboard and home screen. The reply is the same whether or not the username
exists, so the form cannot be used to discover accounts. Requests are limited
to 10 an hour per address.

Why the approval step: without it, anyone who can reach the login page could
sign up and see a kitchen's records. A `role` sent to `/register` is
ignored — tested. Sign-ups are also limited to 10 per hour per address.

Pending people are left out of the roster, so they cannot be assigned jobs
before they are approved.

Admins can still create accounts directly, choosing the username and initial
password themselves; that path is unchanged.

---

## 6. How a session works

1. `POST /api/auth/login` verifies the password with `bcrypt.compare`.
2. It returns a **15-minute access token** (a signed JWT) in the JSON body,
   and sets a **30-day refresh token** as an `httpOnly` cookie.
3. The frontend keeps the access token **in a variable, not localStorage**.
   Anything in localStorage is readable by any script on the page; an
   `httpOnly` cookie is not readable by JavaScript at all.
4. On start-up, and again before the access token expires, the app calls
   `POST /api/auth/refresh`. The cookie is enough, so nobody retypes a
   password, and each refresh **rotates** the token — a copy captured earlier
   stops working.
5. Refresh tokens are stored as SHA-256 hashes and can be revoked, which is
   what makes logout, a password change and an admin reset take effect
   immediately on every device.
6. The refresh cookie is `HttpOnly`, `Secure` in production, limited to
   `/api/auth`, and **`SameSite=Strict`** when the page and API share an origin
   (Vercel, or Express serving the page) — the browser never sends it on a
   request started by another site. It is `SameSite=None` only when
   `CORS_ORIGINS` names a separate frontend.
7. Sign-in attempts are counted per IP in the `app_rate_limits` table, so the
   limit holds even when Vercel runs many copies of the server at once. The
   per-account lockout (`MAX_FAILED_ATTEMPTS`) is separate and also stored in
   the database.

**Rotating the JWT secret:** set `JWT_SECRET_PREVIOUS` to the current value,
set `JWT_SECRET` to a new one, redeploy, and remove `JWT_SECRET_PREVIOUS` a day
later. Nobody is signed out. Rotating `REFRESH_TOKEN_SECRET` is not needed —
refresh tokens are random database records, not signed tokens.

---

## 7. Integrating this into an existing deployment

If you are currently serving `index.html` as a static file somewhere, you have
two options.

### Option A — serve everything from Express (recommended)

Deploy the whole folder to any Node host (Render, Railway, Fly.io, a VPS).
Set the environment variables from section 3 and run `npm start`. Leave
`CORS_ORIGINS` empty; same origin means no CORS, no cross-site cookie rules,
and one thing to deploy.

### Option B — keep the frontend where it is

1. Deploy `server/` on its own; note its URL.
2. In `index.html`, set the API base near the top of the script:
   ```js
   var API_BASE = 'https://bookends-api.example.com';
   ```
3. Set `CORS_ORIGINS` to the exact origin serving `index.html`, comma
   separated if more than one. Never `*` — the browser refuses a wildcard
   origin together with credentials, and the refresh cookie needs credentials.
4. Both sides must be **HTTPS**, because the cookie is `Secure` and
   `SameSite=None` in production.

### Checklist either way

- [ ] `npm install` on the host
- [ ] environment variables set (not a committed `.env`)
- [ ] `npm run migrate`
- [ ] `npm run seed`, then remove `SEED_ADMIN_PASSWORD`
- [ ] sign in, confirm the people list loads
- [ ] `drop table bk_users;` and tell everyone to change their password
- [ ] served over HTTPS
- [ ] `GET /api/health` returns `{"ok":true}`

---

## 8. What changed in `index.html`

The UI, styles and layout are untouched. The changes are confined to the code
that used to check passwords locally:

| Area | Before | After |
|---|---|---|
| `Api` / `Auth` | — | new block: fetch wrapper, silent refresh, session state |
| `freshData()` | seeded 11 users with `pw: '1234'` | seeds no users and no passwords |
| `load()` | restored the session from a user id in localStorage | strips any leftover `pw` fields; the session comes from the refresh cookie |
| `doLogin()` | compared `u.pw !== pw` in the browser | posts to `/api/auth/login` |
| `savePw()` | wrote `ME.pw = a` | posts to `/api/auth/change-password` |
| `saveUser()` | pushed a local record with `pw` | posts to `/api/admin/users` |
| `resetPw` / `delUser` / `chrole` | edited the local array | call the admin API |
| `logout` | removed a localStorage key | revokes the session server-side |
| `usersSheet()` | read the local array | loads from `/api/admin/users`, and now shows last sign-in and whether someone has ever signed in |
| Cloud sync | synced everything straight to Supabase with the anon key | goes through `/api/sync` and `/api/photos` once signed in; no key in the page, nothing to configure. Unsent changes survive an app restart |
| boot | synchronous | waits for the session, then renders |

### Offline behaviour

The app is an installed PWA and kitchens lose wifi, so this is worth knowing:

- **Signing in needs a connection.** A password can only be checked by the
  server. The login screen says so when the device is offline.
- **Once signed in, the app works offline as before.** Checklists, photos and
  expiry records are kept locally and sync when the connection returns.
- On start-up without a connection, the app opens on the cached profile and
  the local data, and shows "No connection — showing the work saved on this
  device". The cache holds a name, role and location; no password material.

---

## 9. Task and product data — resolved

This section used to say that `bk_tasks` and `bk_products` were synced
straight from the browser with the Supabase anon key under `using (true)`
policies, so anyone who opened the page could read or overwrite every
kitchen's records.

That is closed. The tables now live in this app's own database and are only
reachable through `/api/sync`, behind `requireAuth`, with per-kitchen scoping
and a read-only Auditor. Photos go through `/api/photos`. `index.html` holds no
Supabase URL or key, and the page's CSP only lets it talk to its own origin.

If an old Supabase project still holds the data, move it with
`npm run import:supabase` and then lock it (section 10, steps 6–7).

---

## 10. Deploy on Vercel + Neon

Written for: whoever sets up the live site. Takes about 30 minutes.

### What runs where

| Piece | Where |
|---|---|
| `index.html` | Vercel's CDN, from `public/` (built by `npm run build`) |
| `/api/*` | one Vercel Function, `api/index.js` → `server/app.js` |
| Accounts, tasks, products, rate limits | **Neon** Postgres |
| Photos | **Vercel Blob** (old photos stay on Supabase Storage until moved) |
| Daily cleanup | Vercel Cron → `/api/cron/cleanup` at 03:00 UTC |

Vercel publishes `public/` **only**, so `server/`, `schema.sql` and any `.env`
can never be downloaded from the site.

### Steps

1. **Push to GitHub.** Check `.env` is not in the commit (`git status` must
   not list it).

2. **Import the repo in Vercel** → Framework preset **Other**. `vercel.json`
   already sets the build command and output folder; leave those blank.

3. **Neon:** Vercel → Storage → **Create → Neon**, connect it to the project.
   It sets `DATABASE_URL` for you. Make sure it is the **pooled** URL (host
   contains `-pooler`). Create a separate Neon **branch** for Preview
   deployments, so a preview link can never touch live data.

4. **Blob:** Vercel → Storage → **Create → Blob**, connect it. It sets
   `BLOB_READ_WRITE_TOKEN`.

5. **Environment variables** (Settings → Environment Variables). Give
   **Production** and **Preview** different secrets:

   | Variable | Value |
   |---|---|
   | `DATABASE_SSL` | `true` |
   | `JWT_SECRET` | new random value (command in section 3) |
   | `REFRESH_TOKEN_SECRET` | another new random value |
   | `CRON_SECRET` | another new random value |
   | `DEFAULT_PASSWORD`, `MIN_PASSWORD_LENGTH`, `MAX_FAILED_ATTEMPTS`, `LOCKOUT_MINUTES` | as in `.env.example` |
   | `SEED_ADMIN_UID`, `SEED_ADMIN_NAME` | `adminexe`, `Admin EXE` |
   | `SEED_ADMIN_PASSWORD` | Admin EXE's first password on the live site, 10+ characters. Remove it after the first deploy |
   | `CORS_ORIGINS` | leave **unset** |

   Do not reuse the secrets from your local `.env`. `NODE_ENV` is set by
   Vercel.

6. **The database sets itself up.** Every deployment runs the table setup
   (`migrate`) as part of the build, and — while `SEED_ADMIN_PASSWORD` is set —
   creates the Super Admin and the starting roster (`seed`). Both only add
   what is missing: existing accounts, passwords and records are never
   touched. If either fails, the deployment fails and the old version stays
   live. There is nothing to run by hand.

   Optional — **keep everyone's existing accounts and passwords** from the
   local database instead of the seed roster: deploy once **without**
   `SEED_ADMIN_PASSWORD` (this creates empty tables), then copy the accounts
   across (Neon URL from Neon → Connection Details):
     ```bash
     pg_dump -h localhost -p 5433 -U postgres -d bookends --data-only \
       -t app_users -t app_user_credentials > accounts.sql
     psql "<neon url>" -f accounts.sql
     ```
     Delete `accounts.sql` afterwards — it contains password hashes.

   Optional — cleaning and product records from the old Supabase cloud sync:
   make a local `.env` whose `DATABASE_URL` is the Neon URL, add
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to it,
   then:

   ```bash
   npm run import:supabase                    # records only; old photo links keep working
   npm run import:supabase -- --copy-photos   # also moves photos to Blob (needs BLOB_READ_WRITE_TOKEN)
   ```

   It is safe to run again; it never overwrites a newer edit.

7. **Lock the old Supabase tables** (Supabase → SQL Editor), once the import
   counts look right. This stops anyone using the old anon key that earlier
   versions of the page carried:

   ```sql
   drop policy if exists bk_tasks_all    on bk_tasks;
   drop policy if exists bk_products_all on bk_products;
   drop policy if exists bk_users_all    on bk_users;
   revoke all on bk_tasks, bk_products from anon, authenticated;
   drop policy if exists bk_photos_all on storage.objects;
   ```

   Keep the `bk-photos` bucket **public** until you have run
   `--copy-photos`, or old photos stop showing. Then remove
   `SUPABASE_SERVICE_ROLE_KEY` from your local `.env`.

8. **Deploy** (push to `main`, or Deployments → Redeploy). Sign in as
   `adminexe` with `SEED_ADMIN_PASSWORD`, then delete that variable in Vercel.

9. **Protect previews:** Settings → Deployment Protection → **Vercel
   Authentication** on for Preview.

10. **Custom domain** (optional): Settings → Domains.

### Check the live site

- `https://<your-site>/api/health` → `{"ok":true,...}`
- `https://<your-site>/server/server.js` and `/.env` → the app page, never the file
- Sign in. In the browser's developer tools → Application → Cookies,
  `bk_refresh` shows `HttpOnly`, `Secure`, `SameSite=Strict`
- Network tab: no requests to `supabase.co` except loading old photos
- Profile → ☁️ Cloud sync says **All devices in sync**
- Mark a cleaning job done on one phone; it appears on another within a minute
- Vercel → Settings → Cron Jobs lists `/api/cron/cleanup`

### Running it elsewhere

Nothing here is Vercel-only. `npm start` still runs the whole app as one
server (local, Render, a VPS); it serves `index.html` itself and runs the
cleanup hourly instead of by cron.

---

## Rebuilt on 30 Sep 2026 — Management server code and daily checklists

The live site's page had Management → User Management, Job Management and
Task Review, but the server code behind them was never pushed to GitHub. It
was rebuilt from exactly how the page calls it, on the **same tables the live
database already has**, so jobs already set up there are read as they are:

| Endpoint | Table(s) | What it does |
|---|---|---|
| `GET/POST /api/checklist/types`, `PATCH/DELETE /api/checklist/types/:id` | `bk_job_types` | job types; built-ins can be switched off, not removed; a type with services cannot be deleted |
| `GET/POST /api/checklist/items`, `PATCH/DELETE /api/checklist/items/:tk`, `POST /api/checklist/items/:tk/restore` | `bk_checklist` | services, keyed by slot (`W12`, `M3`, `W100`); slots are never reused |
| `GET /api/checklist/items/history` | `bk_checklist_audit` | who added, renamed, edited, deleted, put back |
| `PATCH/POST /api/admin/users` (email, jobTypes, disabled) | `app_users.email`, `app_users.job_types` (jsonb) | User Management extras |
| `POST /api/admin/wipe` `{ confirm: "WIPE ALL DATA" }` | `app_admin_audit` | Super Admin only. Deletes records (jobs, labels, daily checklists, photo files), keeps accounts and setup |
| `/api/sync` | — | now returns the wipe **epoch** (time of the last wipe) and refuses uploads from before it (`409 DATA_WIPED`); also delivers a job given to someone at another kitchen |

Reading the setup is open to every signed-in account; changing it is the
Super Admin's only.

### Daily checklists (Lunch / Dinner / Closing)

**Checklist** sits directly below **Home**. Lunch 12:00–1:30 PM, Dinner
5–6 PM, Closing 10 PM–1 AM (crosses midnight; 12:30 AM belongs to the
previous day's shift), India time, checked by the server's clock. A photo is
compulsory before the Google Form opens. API `/api/checklists`, table
`app_checklists`, form settings `CHECKLIST_FORM_*` in `.env.example`.
`npm test` checks every window boundary against both copies of the logic.

Google Form changes still to make by its owner: a required *File upload*
question (images) for the photo, and a *Checklist type* question with the
options exactly `Lunch`, `Dinner`, `Closing` (then set
`CHECKLIST_FORM_TYPE_ENTRY`).
