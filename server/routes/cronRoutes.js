'use strict';
/* ---------------------------------------------------------------------------
   /api/cron — scheduled jobs (Vercel Cron, see vercel.json).

   Vercel calls these with "Authorization: Bearer <CRON_SECRET>". Anyone else
   gets 401, and with no CRON_SECRET configured every caller does, so the job
   can never be triggered by the public.

     GET /api/cron/cleanup   delete expired sessions, rate-limit windows and
                             sign-in history older than six months
     GET /api/cron/tick      checklist reminders and label expiry — for an
                             external scheduler calling it every minute
   --------------------------------------------------------------------------- */

var express = require('express');
var crypto = require('crypto');
var config = require('../config/env');
var cleanup = require('../services/cleanupService');
var scheduler = require('../services/scheduler');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

/* Constant-time comparison, so the response time does not reveal how much
   of a guessed secret was right. Hashing first makes both sides the same
   length, which timingSafeEqual requires. */
function sameSecret(given, expected) {
  var a = crypto.createHash('sha256').update(String(given)).digest();
  var b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  var m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!config.cronSecret || !m || !sameSecret(m[1], config.cronSecret)) {
    return res.status(401).json({ error: 'Not allowed', code: 'UNAUTHORIZED' });
  }
  next();
}

router.get('/cleanup', requireCronSecret, asyncHandler(function (req, res) {
  return cleanup.run().then(function (counts) {
    console.log('[cron] cleanup ' + JSON.stringify(counts));
    res.json({ ok: true, deleted: counts });
  });
}));

router.get('/tick', requireCronSecret, asyncHandler(function (req, res) {
  return scheduler.tick().then(function (out) { res.json({ ok: true, result: out }); });
}));

module.exports = router;
