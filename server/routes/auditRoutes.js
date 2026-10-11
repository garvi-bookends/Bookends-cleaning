'use strict';
/* ---------------------------------------------------------------------------
   /api/audit — the Audit Log (Admin Settings). Admins only.

     GET /api/audit?loc=&action=&from=&to=&before=&limit=
       action: a prefix — 'task', 'checklist', 'label', 'wipe', 'user'
       from/to: YYYY-MM-DD (IST days, inclusive)
       before: an entry id, for "load older"
   --------------------------------------------------------------------------- */

var express = require('express');
var audit = require('../services/audit');
var access = require('../services/access');
var windows = require('../services/checklistWindows');
var restaurants = require('../config/restaurants');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth, access.requireAdmin);

var YMD = /^\d{4}-\d{2}-\d{2}$/;
var ACTIONS = ['task', 'checklist', 'label', 'wipe', 'user'];

router.get('/', asyncHandler(function (req, res) {
  var q = req.query;
  return audit.list({
    loc: restaurants.isRestaurant(q.loc) ? q.loc : null,
    action: ACTIONS.indexOf(q.action) > -1 ? q.action : null,
    from: YMD.test(q.from || '') ? new Date(windows.istInstant(q.from, 0)) : null,
    to: YMD.test(q.to || '') ? new Date(windows.istInstant(windows.addDaysYmd(q.to, 1), 0)) : null,
    before: parseInt(q.before, 10) || null,
    limit: parseInt(q.limit, 10) || 100
  }).then(function (entries) {
    res.set('Cache-Control', 'no-store');
    res.json({ entries: entries });
  });
}));

module.exports = router;
