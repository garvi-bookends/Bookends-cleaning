'use strict';
/* ---------------------------------------------------------------------------
   Copies this app's database into another PostgreSQL database — used to move
   from the local database (or Neon) to Supabase.

     npm run copy-db

   Needs in .env:
     DATABASE_URL     the database to copy FROM (what the app uses now)
     SUPABASE_DB_URL  the database to copy TO. In Supabase: Connect →
                      "Session pooler" (port 5432), with your password filled in.

   What it does:
     1. applies server/db/schema.sql to the target (creates the tables)
     2. copies every row of every app table, parents before children
     3. moves the id counters on past the copied rows

   Sign-in sessions and rate-limit counters are not copied: everyone signs in
   once more on the new database. Safe to run again — a row already in the
   target is left as it is (on conflict do nothing).
   --------------------------------------------------------------------------- */

var fs = require('fs');
var path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
var pg = require('pg');
var connectionParams = require('../db/connectionParams');

/* Read DATE columns as the plain 'YYYY-MM-DD' text. pg's default turns them
   into a JS Date at local midnight, which JSON writes as the previous day in
   UTC on an IST machine — a checklist's shift_date arrived one day early. */
pg.types.setTypeParser(1082, function (v) { return v; });

var SOURCE = process.env.DATABASE_URL || '';
var TARGET = process.env.SUPABASE_DB_URL || process.env.TARGET_DATABASE_URL || '';

/* Parents first, so foreign keys are satisfied as rows arrive. */
var TABLES = [
  'app_users',
  'app_user_credentials',
  'app_login_audit',
  'bk_tasks',
  'bk_products',
  'bk_job_types',
  'bk_checklist',
  'bk_checklist_audit',
  'app_admin_audit',
  'app_checklists',
  'app_settings',
  'app_one_time_fixes',
  /* Photos before the records that point at them. Run `npm run photos-to-blob`
     first: a photo still held as bytes in Postgres cannot travel through the
     JSON this copy uses, so only its Blob link should be left to copy. */
  'app_photos',
  'app_cleaning_tasks',
  'app_checklist_items',
  'app_labels',
  'app_notifications'
];
var SERIAL_TABLES = ['app_login_audit', 'bk_checklist_audit', 'app_admin_audit', 'app_notifications'];
/* schema.sql seeds the built-in job types, so the source's copy of those rows
   (renamed, switched off) must replace the seeded one, not be skipped. */
var UPSERT_KEY = { bk_job_types: 'id' };
var BATCH = 200;

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return '(unreadable URL)'; }
}

function isLocal(url) {
  return /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

function client(url) {
  /* Supabase's certificate is not in Node's default trust store, so a hosted
     target is encrypted without verifying the chain. */
  return new pg.Client(Object.assign(connectionParams(url), { ssl: isLocal(url) ? false : { rejectUnauthorized: false } }));
}

function columns(c, table) {
  return c.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position",
    [table]
  ).then(function (r) { return r.rows.map(function (x) { return x.column_name; }); });
}

function copyTable(src, dst, table) {
  return Promise.all([columns(src, table), columns(dst, table)]).then(function (cols) {
    if (!cols[0].length) { console.log('  - ' + table + ': not in the source, skipped'); return; }
    var shared = cols[0].filter(function (c) { return cols[1].indexOf(c) > -1; });
    if (!shared.length) throw new Error(table + ' is not on the target — add it to schema.sql');
    var list = shared.map(function (c) { return '"' + c + '"'; }).join(', ');
    return src.query('select ' + list + ' from ' + table).then(function (r) {
      var rows = r.rows, saved = 0, i = 0;
      function next() {
        if (i >= rows.length) {
          console.log('  ✓ ' + table + ': ' + saved + ' of ' + rows.length + ' row(s) copied');
          return;
        }
        var chunk = rows.slice(i, i += BATCH);
        var key = UPSERT_KEY[table];
        var onConflict = key
          ? ' on conflict ("' + key + '") do update set ' +
            shared.filter(function (c) { return c !== key; }).map(function (c) { return '"' + c + '" = excluded."' + c + '"'; }).join(', ')
          : ' on conflict do nothing';
        return dst.query(
          'insert into ' + table + ' (' + list + ') select ' + list +
          ' from jsonb_populate_recordset(null::' + table + ', $1::jsonb)' + onConflict,
          [JSON.stringify(chunk)]
        ).then(function (res) { saved += res.rowCount; return next(); });
      }
      return next();
    });
  });
}

function main() {
  if (!SOURCE || !TARGET) {
    console.error('\nSet DATABASE_URL (copy from) and SUPABASE_DB_URL (copy to) in .env first.\n');
    process.exit(1);
  }
  if (SOURCE === TARGET) {
    console.error('\nDATABASE_URL and SUPABASE_DB_URL are the same database — nothing to copy.\n');
    process.exit(1);
  }
  console.log('\n[copy-db] from ' + hostOf(SOURCE) + '\n[copy-db] to   ' + hostOf(TARGET) + '\n');

  var src = client(SOURCE), dst = client(TARGET);
  return src.connect().then(function () {
    return src.query("select count(*)::int as n from app_photos where bytes is not null and url is null")
      .catch(function () { return { rows: [{ n: 0 }] }; });
  }).then(function (r) {
    if (r.rows[0].n) throw new Error(r.rows[0].n + ' photo(s) are still stored inside the database. Run `npm run photos-to-blob` first.');
    return dst.connect();
  }).then(function () {
    var sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    console.log('[copy-db] creating tables on the target');
    return dst.query('begin').then(function () { return dst.query(sql); })
      /* Made by oneTimeFixes.js at boot, not by schema.sql. Its rows must
         come across, or the fixes run again on the new database — and one of
         them resets Admin EXE to the starting password. */
      .then(function () { return dst.query('create table if not exists app_one_time_fixes (key text primary key, done_at timestamptz not null default now())'); })
      .then(function () { return dst.query('commit'); });
  }).then(function () {
    console.log('[copy-db] copying rows');
    return TABLES.reduce(function (p, t) { return p.then(function () { return copyTable(src, dst, t); }); }, Promise.resolve());
  }).then(function () {
    return SERIAL_TABLES.reduce(function (p, t) {
      return p.then(function () {
        return dst.query(
          "select setval(pg_get_serial_sequence('" + t + "', 'id'), coalesce((select max(id) from " + t + "), 0) + 1, false)"
        );
      });
    }, Promise.resolve());
  }).then(function () {
    return dst.query("select uid from app_users where role = 'superadmin'");
  }).then(function (r) {
    console.log('\n[copy-db] done. Super Admin on the target: ' + (r.rows[0] ? r.rows[0].uid : '(none)'));
    console.log('[copy-db] Point DATABASE_URL at the target to start using it.\n');
  }).then(function () {
    return Promise.all([src.end(), dst.end()]);
  }).catch(function (err) {
    console.error('\n[copy-db] failed: ' + err.message + '\n');
    return dst.query('rollback').catch(function () {}).then(function () {
      return Promise.all([src.end().catch(function () {}), dst.end().catch(function () {})]);
    }).then(function () { process.exit(1); });
  });
}

main();
