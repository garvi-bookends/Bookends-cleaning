'use strict';
/* ---------------------------------------------------------------------------
   Housekeeping for tables that only ever grow.

   Nothing here affects security — an expired refresh token or rate-limit
   window is already ignored — it only keeps the tables small. Called hourly
   by server/server.js on a long-running host, and once a day by the Vercel
   cron (GET /api/cron/cleanup), where no process stays up to run a timer.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var refreshTokens = require('../models/refreshTokenModel');
var photos = require('./photoStore');
var notify = require('./notify');

/* Sign-in history is kept for six months: long enough to look into "someone
   was guessing at my account in spring", short enough not to pile up. */
var AUDIT_KEEP_DAYS = 180;

function run() {
  var out = {};
  return refreshTokens.purgeExpired()
    .then(function (n) {
      out.refreshTokens = n;
      return db.query('delete from app_rate_limits where reset_at < now()');
    })
    .then(function (r) {
      out.rateLimits = r.rowCount;
      return db.query('delete from app_login_audit where at < now() - make_interval(days => $1)', [AUDIT_KEEP_DAYS]);
    })
    .then(function (r) {
      out.loginAudit = r.rowCount;
      return photos.purgeAbandoned();
    })
    .then(function (n) {
      out.abandonedPhotos = n;
      return notify.purgeOld();
    })
    .then(function (n) {
      out.oldNotifications = n;
      return out;
    });
}

module.exports = { run: run, AUDIT_KEEP_DAYS: AUDIT_KEEP_DAYS };
