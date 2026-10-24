'use strict';
/* ---------------------------------------------------------------------------
   /api/dashboard — the admin overview of all 8 restaurants.

   One row per restaurant: cleaning tasks (pending, overdue, done today),
   today's three checklists (Submitted / Pending / Missed) and labels
   (Active, Expiring Soon, Expired). Each row says what needs attention, and
   the rows come back with the restaurants that need it most first.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var access = require('../services/access');
var windows = require('../services/checklistWindows');
var settings = require('../services/settings');
var checklists = require('../models/checklistModel');
var labels = require('../models/labelModel');
var restaurants = require('../config/restaurants');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth, access.requireAdmin);

router.get('/', asyncHandler(function (req, res) {
  var now = Date.now();
  var today = windows.istParts(now).ymd;
  var dayStart = new Date(windows.istInstant(today, 0));
  /* The current (or most recent) shift of each checklist. Closing at 00:30
     still belongs to yesterday's shift. */
  var states = windows.allDayStates(now);
  var dates = [];
  states.forEach(function (s) { if (dates.indexOf(s.shiftDate) === -1) dates.push(s.shiftDate); });

  return Promise.all([
    db.query(
      "select loc, count(*) filter (where status = 'PENDING')::int as pending, " +
      "count(*) filter (where status = 'PENDING' and due_at < now())::int as overdue, " +
      "count(*) filter (where status = 'DONE' and completed_at >= $1)::int as done_today, " +
      "count(*) filter (where status = 'DONE')::int as done " +
      'from app_cleaning_tasks group by loc', [dayStart]),
    labels.counts(null),
    checklists.listForShifts(dates, null),
    settings.get('checklist_tracking_since', today)
  ]).then(function (got) {
    var taskBy = {};
    got[0].rows.forEach(function (r) { taskBy[r.loc] = r; });
    var labelBy = got[1];
    var sent = {};
    got[2].forEach(function (c) { sent[c.loc + '|' + c.type + '|' + c.shiftDate] = c; });
    var since = got[3];

    var totals = {
      tasks: { pending: 0, overdue: 0, doneToday: 0, done: 0 },
      checklists: { SUBMITTED: 0, PENDING: 0, MISSED: 0 },
      labels: { ACTIVE: 0, EXPIRING: 0, EXPIRED: 0 }
    };

    var rows = restaurants.RESTAURANTS.map(function (r) {
      var t = taskBy[r.id] || { pending: 0, overdue: 0, done_today: 0, done: 0 };
      var l = labelBy[r.id] || { ACTIVE: 0, EXPIRING: 0, EXPIRED: 0 };
      /* Checklists are open all day: today's are Submitted or Pending. */
      var cks = states.map(function (s) {
        var sub = sent[r.id + '|' + s.type + '|' + s.shiftDate];
        var status = sub ? 'SUBMITTED'
          : (now < s.endsAt ? 'PENDING' : (s.shiftDate >= since ? 'MISSED' : 'PENDING'));
        totals.checklists[status]++;
        return { type: s.type, label: s.label, shiftDate: s.shiftDate, open: s.open, status: status,
          submissionId: sub ? sub.id : null, submittedAt: sub ? sub.submittedAt : null };
      });

      totals.tasks.pending += t.pending; totals.tasks.overdue += t.overdue;
      totals.tasks.doneToday += t.done_today; totals.tasks.done += t.done;
      totals.labels.ACTIVE += l.ACTIVE; totals.labels.EXPIRING += l.EXPIRING; totals.labels.EXPIRED += l.EXPIRED;

      /* What needs attention, worst first. The score orders the restaurants. */
      var reasons = [], score = 0;
      var missed = cks.filter(function (c) { return c.status === 'MISSED'; });
      if (l.EXPIRED) { reasons.push(l.EXPIRED + ' expired label' + (l.EXPIRED === 1 ? '' : 's')); score += 100 * l.EXPIRED; }
      if (t.overdue) { reasons.push(t.overdue + ' overdue task' + (t.overdue === 1 ? '' : 's')); score += 50 * t.overdue; }
      if (missed.length) { reasons.push('Missed: ' + missed.map(function (c) { return c.label.replace(' Checklist', ''); }).join(', ')); score += 40 * missed.length; }
      if (l.EXPIRING) { reasons.push(l.EXPIRING + ' label' + (l.EXPIRING === 1 ? '' : 's') + ' expiring soon'); score += 10 * l.EXPIRING; }
      var pendingOnTime = t.pending - t.overdue;
      if (pendingOnTime) { reasons.push(pendingOnTime + ' task' + (pendingOnTime === 1 ? '' : 's') + ' pending'); score += pendingOnTime; }

      return {
        id: r.id, name: r.name, code: r.code, city: r.city,
        tasks: { pending: t.pending, overdue: t.overdue, doneToday: t.done_today, done: t.done },
        checklists: cks,
        labels: l,
        attention: score >= 10 ? 'high' : score > 0 ? 'low' : 'none',
        score: score,
        reasons: reasons
      };
    });

    rows.sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
    res.set('Cache-Control', 'no-store');
    res.json({ serverNow: now, today: today, restaurants: rows, totals: totals, expiringSoonHours: labels.EXPIRING_SOON_HOURS });
  });
}));

module.exports = router;
