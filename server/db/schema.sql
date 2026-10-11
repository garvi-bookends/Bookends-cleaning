-- ===========================================================================
-- Bookends Cleaning — authentication schema
--
-- Run once with:  npm run migrate
-- Safe to re-run: every statement is idempotent.
--
-- Design note: profiles (app_users) and secrets (app_user_credentials) are
-- deliberately in SEPARATE tables. Nothing that reads a profile can ever
-- accidentally select a password hash, and the roster endpoint physically
-- cannot leak one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. User profiles — the non-secret half of an account
-- ---------------------------------------------------------------------------
create table if not exists app_users (
  id                   text        primary key,
  uid                  text        not null unique,          -- login username, always lower case
  name                 text        not null,
  role                 text        not null default 'staff',
  loc                  text,                                  -- null = all locations
  first_login          boolean     not null default true,      -- req 6: first-login status
  must_change_password boolean     not null default true,
  last_login_at        timestamptz,                            -- req 6: last login date/time
  login_count          integer     not null default 0,
  disabled             boolean     not null default false,
  created_at           timestamptz not null default now(),     -- req 6: account creation date
  created_by           text,
  updated_at           timestamptz not null default now(),
  constraint app_users_uid_format check (uid ~ '^[a-z0-9]{2,32}$'),
  constraint app_users_role_valid check (
    role in ('superadmin','exec','aexec','admin','hok','manager','staff','auditor')
  )
);

-- Self sign-up. A person who creates their own account starts out pending:
-- they cannot sign in until the Super Admin approves them and sets their role.
-- Added with ALTER so an existing database picks it up on the next migrate.
alter table app_users add column if not exists pending boolean not null default false;

-- "Forgot password?" from the login screen sets this. The Super Admin sees it
-- on their dashboard and sets a new temporary password, which clears it.
alter table app_users add column if not exists reset_requested_at timestamptz;

-- Super Admin: the one account that approves self sign-ups.
-- The role list is widened by dropping and re-adding the check, so an existing
-- database picks it up on the next migrate.
alter table app_users drop constraint if exists app_users_role_valid;
alter table app_users add constraint app_users_role_valid check (
  role in ('superadmin','exec','aexec','admin','hok','manager','staff','auditor')
);

-- At most ONE Super Admin, enforced by the database itself rather than by
-- trusting every code path to check. A partial unique index over a constant
-- expression allows any number of other rows, but only one 'superadmin'.
create unique index if not exists app_users_one_superadmin
  on app_users ((true)) where role = 'superadmin';

-- ---------------------------------------------------------------------------
-- 2. Credentials — the secret half. Only the backend ever touches this.
-- ---------------------------------------------------------------------------
create table if not exists app_user_credentials (
  user_id             text        primary key references app_users(id) on delete cascade,
  password_hash       text        not null,                   -- bcrypt, cost 12. Never a plaintext password.
  password_updated_at timestamptz not null default now(),
  failed_attempts     integer     not null default 0,
  locked_until        timestamptz
);

-- ---------------------------------------------------------------------------
-- 3. Refresh tokens — makes a session revocable instead of only expiring
--    Only the SHA-256 of the token is stored, so a database dump cannot be
--    replayed as a live session.
-- ---------------------------------------------------------------------------
create table if not exists app_refresh_tokens (
  id         text        primary key,
  user_id    text        not null references app_users(id) on delete cascade,
  token_hash text        not null unique,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip         text
);

create index if not exists app_refresh_tokens_user on app_refresh_tokens (user_id);
create index if not exists app_refresh_tokens_exp  on app_refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- 4. Login audit trail
-- ---------------------------------------------------------------------------
create table if not exists app_login_audit (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  uid        text,
  user_id    text,
  success    boolean     not null,
  reason     text,
  ip         text,
  user_agent text
);

create index if not exists app_login_audit_at  on app_login_audit (at desc);
create index if not exists app_login_audit_uid on app_login_audit (uid);

-- ---------------------------------------------------------------------------
-- 4b. Rate-limit counters, shared by every server instance
--     (see server/middleware/rateLimit.js). Rows are short-lived; the cleanup
--     job deletes them once reset_at has passed.
-- ---------------------------------------------------------------------------
create table if not exists app_rate_limits (
  key      text        primary key,
  count    integer     not null default 0,
  reset_at timestamptz not null
);

create index if not exists app_rate_limits_reset on app_rate_limits (reset_at);

-- ---------------------------------------------------------------------------
-- 4c. Cleaning tasks and expiry products.
--
-- Same shape the app has always synced: the whole record as jsonb, plus the
-- location and a last-changed time lifted out so the server can filter on
-- them. Previously these tables sat in Supabase and the browser wrote to them
-- directly with a public key. Now only this backend touches them, through
-- /api/sync, which checks who is asking and which kitchen they belong to.
-- ---------------------------------------------------------------------------
create table if not exists bk_tasks (
  id         text        primary key,
  loc        text,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

create table if not exists bk_products (
  id         text        primary key,
  loc        text,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4d. User Management extras: an email, and the job types a person works on
--     (a JSON list of job type ids; empty = every job type).
-- ---------------------------------------------------------------------------
alter table app_users add column if not exists email text;
alter table app_users add column if not exists job_types jsonb default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 4e. Job Management — the same tables the live site uses.
--
-- bk_job_types        Cleaning, Labelling, and any the Super Admin adds.
-- bk_checklist        one row per service slot ('W12', 'M3', 'W100'): every
--                     change to a built-in cleaning job, and every job added.
--                     Task ids are built from the slot, so it is never reused.
-- bk_checklist_audit  who added, renamed, edited, deleted or put back a job.
-- ---------------------------------------------------------------------------
create table if not exists bk_job_types (
  id          text        primary key,
  name        text        not null,
  description text,
  active      boolean     not null default true,
  builtin     boolean     not null default false,
  sort        integer     not null default 100,
  created_by  text,
  created_at  timestamptz not null default now(),
  edited_by   text,
  edited_at   timestamptz,
  updated_at  timestamptz not null default now(),
  constraint bk_job_types_id_format check (id ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  constraint bk_job_types_name_len  check (char_length(name) between 1 and 60),
  constraint bk_job_types_desc_len  check (description is null or char_length(description) <= 300)
);
insert into bk_job_types (id, name, description, builtin, sort) values
  ('cleaning',  'Cleaning',  'Kitchen deep-clean checklist — weekly and monthly jobs', true, 10),
  ('labelling', 'Labelling', 'Writing and applying product labels', true, 20),
  ('checklist', 'Checklist', 'Lunch, Dinner and Closing checklists — restaurant-wise', true, 30)
on conflict (id) do nothing;

create table if not exists bk_checklist (
  tkey        text        primary key,
  name        text,
  zone        text,
  freq        text,
  day         integer,
  loc         text,
  custom      boolean     not null default false,
  deleted     boolean     not null default false,
  prev_name   text,
  created_by  text,
  created_at  timestamptz not null default now(),
  edited_by   text,
  edited_at   timestamptz,
  updated_at  timestamptz not null default now(),
  job_type    text        not null default 'cleaning',
  assigned_to text,
  at_time     text,
  end_date    text,
  enabled     boolean     not null default false,
  locs        jsonb,
  assignees   jsonb,
  constraint bk_checklist_tkey_format check (tkey ~ '^[WM][0-9]{1,3}$'),
  constraint bk_checklist_name_len    check (name is null or char_length(name) between 1 and 120),
  constraint bk_checklist_day_valid   check (day is null or (day >= 0 and day <= 6)),
  constraint bk_checklist_freq_valid  check (freq is null or freq in ('D','W','M')),
  constraint bk_checklist_custom_full check (not custom or (name is not null and zone is not null and freq is not null))
);

create table if not exists bk_checklist_audit (
  id        bigserial   primary key,
  at        timestamptz not null default now(),
  action    text        not null,
  tkey      text        not null,
  prev_name text,
  new_name  text,
  user_id   text,
  user_name text,
  user_role text,
  constraint bk_checklist_audit_action check (action in ('add','rename','edit','delete','restore'))
);
create index if not exists bk_checklist_audit_at on bk_checklist_audit (at desc);

-- ---------------------------------------------------------------------------
-- 4f. Admin audit — every data wipe, who did it and what went. The time of
--     the latest wipe is also the sync "epoch": a device that last synced
--     before it drops its copy instead of uploading deleted records back.
-- ---------------------------------------------------------------------------
create table if not exists app_admin_audit (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  action     text        not null,
  actor_id   text,
  actor_uid  text,
  actor_role text,
  ip         text,
  detail     jsonb,
  constraint app_admin_audit_action check (action = 'wipe')
);

-- ---------------------------------------------------------------------------
-- 4g. Daily checklists — Lunch, Dinner and Closing
--
-- One row each time someone completes the in-app step of a checklist (sent
-- taken, inside the time window) before continuing to the Google Form. The
-- server decides the window from its own clock in IST. shift_date is the IST
-- date the window STARTED, so a Closing checklist done at 00:30 on 1 Oct is
-- recorded against the 30 Sep closing shift.
-- ---------------------------------------------------------------------------
create table if not exists app_checklists (
  id             text        primary key,
  user_id        text        references app_users(id) on delete set null,
  user_name      text        not null,
  loc            text,
  checklist_type text        not null,
  shift_date     date        not null,
  start_time     timestamptz not null,
  end_time       timestamptz not null,
  photo          text,       -- unused: checklists no longer take a photo
  status         text        not null default 'SUBMITTED',
  submitted_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint app_checklists_type_valid   check (checklist_type in ('LUNCH','DINNER','CLOSING')),
  constraint app_checklists_status_valid check (status in ('AVAILABLE','SUBMITTED','MISSED','CLOSED'))
);
-- Databases created while a photo was compulsory: it no longer is.
alter table app_checklists alter column photo drop not null;
-- The ticked checklist: one { section, question, done } per question.
alter table app_checklists add column if not exists answers jsonb;
alter table app_checklists drop constraint if exists app_checklists_photo_present;

-- One of each checklist per RESTAURANT per shift. It used to be one per
-- person, so someone who looks after several restaurants could send Lunch
-- for the first and was then refused for every other one.
drop index if exists app_checklists_one_per_shift;
create unique index if not exists app_checklists_one_per_loc_shift
  on app_checklists (loc, checklist_type, shift_date);
create index if not exists app_checklists_shift on app_checklists (shift_date desc, loc);

-- ---------------------------------------------------------------------------
-- 4h. Audit log — every important action, not only wipes.
--
-- app_admin_audit started as the wipe log (and the latest wipe is still the
-- sync epoch, read with action = 'wipe'). It now records task, checklist and
-- label actions too, so the action check is widened and the columns the
-- Audit Log screen shows are added. A wipe NEVER deletes from this table.
-- ---------------------------------------------------------------------------
alter table app_admin_audit drop constraint if exists app_admin_audit_action;
alter table app_admin_audit add constraint app_admin_audit_action check (char_length(action) between 1 and 40);
alter table app_admin_audit add column if not exists actor_name  text;
alter table app_admin_audit add column if not exists loc         text;
alter table app_admin_audit add column if not exists entity_type text;
alter table app_admin_audit add column if not exists entity_id   text;
alter table app_admin_audit add column if not exists summary     text;
create index if not exists app_admin_audit_at  on app_admin_audit (at desc);
create index if not exists app_admin_audit_loc on app_admin_audit (loc, at desc);

-- ---------------------------------------------------------------------------
-- 4i. Small key/value settings the server keeps for itself.
--     checklist_tracking_since: the first IST date a checklist that was not
--     sent counts as Missed. Without it every day before the app existed
--     would show as Missed. A wipe moves it to the wipe date.
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value)
  values ('checklist_tracking_since', to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD'))
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4j. Photos — cleaning task, checklist and label photos.
--
-- One row per uploaded photo. The bytes live here, or, when a Vercel Blob
-- store is configured, in the store with only its URL here. Photos are only
-- ever handed out through short-lived signed links, made for someone who is
-- allowed to see the record the photo belongs to.
-- ---------------------------------------------------------------------------
create table if not exists app_photos (
  id          text        primary key,
  loc         text,
  mime        text        not null,
  size        integer     not null,
  bytes       bytea,
  url         text,
  uploaded_by text        references app_users(id) on delete set null,
  attached_to text,                                -- 'task:CT-…', 'label:LB-…', 'checklist:CL-…'
  created_at  timestamptz not null default now(),
  constraint app_photos_mime check (mime in ('image/jpeg', 'image/png')),
  constraint app_photos_stored check (bytes is not null or url is not null)
);
create index if not exists app_photos_unattached on app_photos (created_at) where attached_to is null;

-- ---------------------------------------------------------------------------
-- 4k. Cleaning tasks — created and assigned to a restaurant by an admin,
--     completed with a photo by that restaurant's location manager.
-- ---------------------------------------------------------------------------
create table if not exists app_cleaning_tasks (
  id                  text        primary key,
  title               text        not null,
  loc                 text        not null,
  instructions        text,
  due_at              timestamptz not null,
  ref_photo_id        text        references app_photos(id) on delete set null,
  status              text        not null default 'PENDING',
  created_by          text        references app_users(id) on delete set null,
  created_by_name     text,
  created_at          timestamptz not null default now(),
  completed_by        text        references app_users(id) on delete set null,
  completed_by_name   text,
  completed_at        timestamptz,
  completion_photo_id text        references app_photos(id) on delete set null,
  completion_note     text,
  updated_at          timestamptz not null default now(),
  constraint app_cleaning_tasks_status check (status in ('PENDING', 'DONE')),
  constraint app_cleaning_tasks_title_len check (char_length(title) between 1 and 120),
  constraint app_cleaning_tasks_instr_len check (instructions is null or char_length(instructions) <= 2000),
  constraint app_cleaning_tasks_note_len check (completion_note is null or char_length(completion_note) <= 500),
  constraint app_cleaning_tasks_done_full check (status <> 'DONE' or (completed_at is not null and completion_photo_id is not null))
);
create index if not exists app_cleaning_tasks_loc on app_cleaning_tasks (loc, status, due_at);

-- ---------------------------------------------------------------------------
-- 4l. Checklist items — what each of Lunch, Dinner and Closing asks for.
--     Edited by admins with the (+) button. A submission keeps its own copy
--     of the wording, so changing an item never rewrites a past record.
-- ---------------------------------------------------------------------------
create table if not exists app_checklist_items (
  id             text        primary key,
  checklist_type text        not null,
  text           text        not null,
  required       boolean     not null default true,
  photo_required boolean     not null default false,
  sort           integer     not null default 100,
  active         boolean     not null default true,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_by     text,
  updated_at     timestamptz not null default now(),
  constraint app_checklist_items_type check (checklist_type in ('LUNCH', 'DINNER', 'CLOSING')),
  constraint app_checklist_items_text_len check (char_length(text) between 1 and 300)
);
create index if not exists app_checklist_items_type on app_checklist_items (checklist_type, active, sort);

-- ---------------------------------------------------------------------------
-- 4m. Labels — a prepared item, when it was made and when it expires, with
--     its photo. expiry_state is what the scheduler last saw, so a change
--     (Active -> Expiring Soon -> Expired) is noticed once, logged once and
--     notified once. What the screens show is worked out from expires_at at
--     the moment of reading, so it is right even between scheduler runs.
-- ---------------------------------------------------------------------------
create table if not exists app_labels (
  id              text        primary key,
  loc             text        not null,
  item_name       text        not null,
  prepared_at     timestamptz not null,
  expires_at      timestamptz not null,
  photo_id        text        references app_photos(id) on delete set null,
  notes           text,
  expiry_state    text        not null default 'ACTIVE',
  created_by      text        references app_users(id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_by_name text,
  updated_at      timestamptz not null default now(),
  discarded_at    timestamptz,
  discarded_by_name text,
  legacy_id       text        unique,              -- bk_products id it was carried over from
  constraint app_labels_state check (expiry_state in ('ACTIVE', 'EXPIRING', 'EXPIRED')),
  constraint app_labels_name_len check (char_length(item_name) between 1 and 120),
  constraint app_labels_notes_len check (notes is null or char_length(notes) <= 500),
  constraint app_labels_dates check (expires_at > prepared_at)
);
create index if not exists app_labels_loc on app_labels (loc, expires_at) where discarded_at is null;

-- ---------------------------------------------------------------------------
-- 4n. Notifications — one row per person. dedupe_key makes a scheduled
--     reminder idempotent: however many times the scheduler runs in its
--     window, each person gets it once.
-- ---------------------------------------------------------------------------
create table if not exists app_notifications (
  id         bigserial   primary key,
  user_id    text        not null references app_users(id) on delete cascade,
  kind       text        not null,
  title      text        not null,
  body       text,
  loc        text,
  link_type  text,
  link_id    text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create unique index if not exists app_notifications_dedupe on app_notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists app_notifications_user on app_notifications (user_id, created_at desc);
create index if not exists app_notifications_unread on app_notifications (user_id) where read_at is null;

create index if not exists bk_tasks_upd    on bk_tasks (updated_at);
create index if not exists bk_products_upd on bk_products (updated_at);
create index if not exists bk_tasks_loc    on bk_tasks (loc, updated_at);
create index if not exists bk_products_loc on bk_products (loc, updated_at);

-- ---------------------------------------------------------------------------
-- 5. Lock these tables away from the browser.
--
-- The frontend holds a Supabase anon key. Enabling RLS with NO policies means
-- the anon and authenticated roles get ZERO access to these tables through
-- PostgREST. This backend connects as the table owner over a direct Postgres
-- connection, which bypasses RLS, so it keeps full access.
-- ---------------------------------------------------------------------------
alter table app_users            enable row level security;
alter table app_user_credentials enable row level security;
alter table app_refresh_tokens   enable row level security;
alter table app_login_audit      enable row level security;
alter table app_rate_limits      enable row level security;
alter table bk_tasks             enable row level security;
alter table bk_products          enable row level security;
alter table bk_job_types         enable row level security;
alter table bk_checklist         enable row level security;
alter table bk_checklist_audit   enable row level security;
alter table app_admin_audit      enable row level security;
alter table app_checklists       enable row level security;
alter table app_settings         enable row level security;
alter table app_photos           enable row level security;
alter table app_cleaning_tasks   enable row level security;
alter table app_checklist_items  enable row level security;
alter table app_labels           enable row level security;
alter table app_notifications    enable row level security;

-- A database that used to be the Supabase cloud-sync target still has the old
-- "anyone may do anything" policies on bk_tasks / bk_products. Drop them, so
-- RLS with no policy means no access for anon at all.
drop policy if exists bk_tasks_all    on bk_tasks;
drop policy if exists bk_products_all on bk_products;

-- Explicitly revoke from the roles PostgREST uses.
--
-- `anon` and `authenticated` exist only on Supabase. On a plain PostgreSQL
-- server they do not, and a bare REVOKE would abort the whole migration with
-- "role does not exist" — so each one is revoked only if it is actually
-- present. That keeps this file runnable on both a local server and Supabase.
do $$
declare
  r   text;
  tbl text;
begin
  for r in
    select rolname::text from pg_roles
     where rolname in ('anon', 'authenticated', 'service_role')
  loop
    for tbl in
      select unnest(array['app_users', 'app_user_credentials',
                          'app_refresh_tokens', 'app_login_audit',
                          'app_rate_limits', 'bk_tasks', 'bk_products',
                          'bk_job_types', 'bk_checklist', 'bk_checklist_audit',
                          'app_admin_audit', 'app_checklists', 'app_settings',
                          'app_photos', 'app_cleaning_tasks', 'app_checklist_items',
                          'app_labels', 'app_notifications'])
    loop
      execute format('revoke all on table %I from %I', tbl, r);
    end loop;
    raise notice 'revoked all access on the app_* tables from role %', r;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Retire the old plaintext-password table.
--
-- bk_users held { uid, pw, ... } as jsonb and was readable by any device
-- holding the anon key. The app no longer reads or writes it. Verify the
-- migration first, then run the DROP below by hand.
-- ---------------------------------------------------------------------------
-- drop table if exists bk_users;
