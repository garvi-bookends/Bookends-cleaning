'use strict';
/* ---------------------------------------------------------------------------
   Data changes that must run once against whichever database the server is
   pointed at — chiefly the live one on Vercel, which has no terminal to run
   a script from.

   Each fix is recorded in app_one_time_fixes inside the same transaction as
   its changes, so it runs exactly once even with several instances starting
   together, and never again after that: re-enabling someone or changing a
   password later is not undone on the next cold start.

   The first /api request waits for this; a failure is logged and the request
   carries on, so a bad fix can never take sign-in down.
   --------------------------------------------------------------------------- */

var db = require('./pool');
var config = require('../config/env');
var passwords = require('../services/passwordService');

var FIXES = [
  {
    /* Admin EXE replaces Husen (Super Admin), Manish and Rutvik, who are deleted. */
    key: '2026-10-admin-exe-delete-old',
    run: function (client) {
      var old = ['husen', 'manish', 'rutvik'];
      /* No password is written in the code: the account starts on the site's
         DEFAULT_PASSWORD and must choose its own at first sign-in. */
      return passwords.hash(config.password.defaultPassword).then(function (hash) {
        /* Deleting cascades to their credentials and sessions; their
           checklist records keep the entry with user_id set to null. */
        return client.query('delete from app_users where uid = any($1)', [old])
          .then(function () {
            return client.query("update app_users set role = 'exec', updated_at = now() where role = 'superadmin' and uid <> 'adminexe'");
          })
          .then(function () {
            return client.query(
              "insert into app_users (id, uid, name, role, loc, first_login, must_change_password, created_by, pending, disabled) " +
              "values ('U-ADMEXE', 'adminexe', 'Admin EXE', 'superadmin', null, true, true, 'fix', false, false) " +
              "on conflict (uid) do update set role = 'superadmin', loc = null, pending = false, disabled = false, " +
              "  must_change_password = true, updated_at = now() " +
              'returning id');
          })
          .then(function (r) {
            var id = r.rows[0].id;
            return client.query(
              'insert into app_user_credentials (user_id, password_hash) values ($1, $2) ' +
              'on conflict (user_id) do update set password_hash = excluded.password_hash, ' +
              '  password_updated_at = now(), failed_attempts = 0, locked_until = null',
              [id, hash]);
          });
      });
    }
  }
];

/* ---------------------------------------------------------------------------
   Fixes for the two-role update (October 2026)
   --------------------------------------------------------------------------- */
var crypto = require('crypto');
var restaurants = require('../config/restaurants');
var windows = require('../services/checklistWindows');

FIXES.push({
  /* The Lunch, Dinner and Closing checklists start with the questions the
     app has always asked, so nothing changes for the restaurants until an
     admin edits them. Only when there are no items yet. */
  key: '2026-10-seed-checklist-items',
  run: function (client) {
    return client.query('select count(*)::int as n from app_checklist_items').then(function (r) {
      if (r.rows[0].n > 0) return;
      var questions = require('../services/checklistItems').ITEMS;
      var rows = [];
      ['LUNCH', 'DINNER', 'CLOSING'].forEach(function (type) {
        questions.forEach(function (q, i) {
          rows.push(client.query(
            'insert into app_checklist_items (id, checklist_type, text, required, photo_required, sort, created_by, updated_by) ' +
            "values ($1, $2, $3, true, false, $4, 'system', 'system')",
            ['CI-' + crypto.randomBytes(6).toString('hex').toUpperCase(), type, q.question, (i + 1) * 10]));
        });
      });
      return Promise.all(rows);
    });
  }
});

FIXES.push({
  /* Products recorded on the old Expiry and Labels screens become labels, so
     their expiry keeps being tracked. The old rows stay where they were.
     Each label starts in the status it is already in, so carrying them over
     does not send a burst of "expired" notifications. */
  key: '2026-10-labels-from-products',
  run: function (client) {
    return Promise.all([
      client.query('select id, loc, data from bk_products'),
      client.query('select id, name from app_users')
    ]).then(function (got) {
      var names = {};
      got[1].rows.forEach(function (u) { names[u.id] = u.name; });
      var now = Date.now();
      var YMD = /^\d{4}-\d{2}-\d{2}$/;
      return got[0].rows.reduce(function (chain, row) {
        var p = row.data || {};
        var loc = p.loc || row.loc;
        if (p.deleted === true || p.status === 'Inactive' || !p.name || !YMD.test(p.expiry || '') || !restaurants.isRestaurant(loc)) return chain;
        var expiresAt = windows.istInstant(p.expiry, 23 * 60 + 59);
        var preparedAt = typeof p.createdAt === 'number' ? p.createdAt
          : YMD.test(p.opened || '') ? windows.istInstant(p.opened, 0) : expiresAt - 86400000;
        if (preparedAt >= expiresAt) preparedAt = expiresAt - 3600000;
        var state = expiresAt <= now ? 'EXPIRED' : expiresAt - now <= 24 * 3600000 ? 'EXPIRING' : 'ACTIVE';
        var id = 'LB-' + crypto.randomBytes(6).toString('hex').toUpperCase();

        return chain.then(function () {
          var photo = String(p.photo || '');
          var m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(photo);
          if (m) {
            var buf = Buffer.from(m[2], 'base64');
            var phId = 'PH-' + crypto.randomBytes(9).toString('hex').toUpperCase();
            return client.query(
              'insert into app_photos (id, loc, mime, size, bytes, attached_to) values ($1, $2, $3, $4, $5, $6)',
              [phId, loc, m[1], buf.length, buf, 'label:' + id]).then(function () { return phId; });
          }
          if (/^https:\/\//.test(photo)) {
            var urlId = 'PH-' + crypto.randomBytes(9).toString('hex').toUpperCase();
            return client.query(
              "insert into app_photos (id, loc, mime, size, url, attached_to) values ($1, $2, 'image/jpeg', 0, $3, $4)",
              [urlId, loc, photo, 'label:' + id]).then(function () { return urlId; });
          }
          return null;
        }).then(function (photoId) {
          return client.query(
            'insert into app_labels (id, loc, item_name, prepared_at, expires_at, photo_id, notes, expiry_state, created_by_name, created_at, legacy_id) ' +
            'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (legacy_id) do nothing',
            [id, loc, String(p.name).slice(0, 120), new Date(preparedAt), new Date(expiresAt), photoId,
              p.note ? String(p.note).slice(0, 500) : null, state, names[p.by] || null,
              new Date(typeof p.createdAt === 'number' ? p.createdAt : preparedAt), String(p.id || row.id)]);
        });
      }, Promise.resolve());
    });
  }
});

function runOne(fix) {
  return db.transaction(function (client) {
    return client.query(
      'insert into app_one_time_fixes (key) values ($1) on conflict (key) do nothing returning key', [fix.key]
    ).then(function (r) {
      if (!r.rows[0]) return false;
      return fix.run(client).then(function () { return true; });
    });
  }).then(function (ran) {
    if (ran) console.log('[fixes] applied ' + fix.key);
  });
}

function runAll() {
  return db.query('create table if not exists app_one_time_fixes (key text primary key, done_at timestamptz not null default now())')
    .then(function () {
      return FIXES.reduce(function (chain, fix) {
        return chain.then(function () { return runOne(fix); });
      }, Promise.resolve());
    });
}

var pending = null;
function ready() {
  if (!pending) {
    pending = runAll().catch(function (err) {
      console.error('[fixes] FAILED:', err.message);
      pending = null;            /* try again on the next request */
    });
  }
  return pending;
}

module.exports = { ready: ready };
