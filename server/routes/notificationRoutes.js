'use strict';
/* ---------------------------------------------------------------------------
   /api/notifications — the bell. Always the signed-in person's own.

     GET  /api/notifications?limit=   { unread, items }
     GET  /api/notifications/count    { unread } — cheap, polled by the app
     POST /api/notifications/:id/read
     POST /api/notifications/read-all
   --------------------------------------------------------------------------- */

var express = require('express');
var notify = require('../services/notify');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(function (req, res) {
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return notify.list(req.auth.id, limit).then(function (out) {
    res.set('Cache-Control', 'no-store');
    res.json(out);
  });
}));

router.get('/count', asyncHandler(function (req, res) {
  return notify.unreadCount(req.auth.id).then(function (n) {
    res.set('Cache-Control', 'no-store');
    res.json({ unread: n });
  });
}));

router.post('/read-all', asyncHandler(function (req, res) {
  return notify.markAllRead(req.auth.id).then(function (n) { res.json({ ok: true, marked: n }); });
}));

router.post('/:id/read', asyncHandler(function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  return notify.markRead(req.auth.id, id).then(function () { res.json({ ok: true }); });
}));

module.exports = router;
