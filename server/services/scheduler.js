'use strict';
/* ---------------------------------------------------------------------------
   Time-based work: checklist reminders and label expiry.

   tick() does everything that is due and is safe to run as often as you like:
   every notification it sends carries a dedupe key, and a label's change of
   status is claimed in the same UPDATE that records it. So it does not matter
   whether it runs once a minute or three times at once on three instances.

   What runs it:
     - server/server.js, every minute, on a long-running host
     - GET /api/cron/tick (with CRON_SECRET), for an external scheduler
     - kick(): any API request starts a tick in the background if none has run
       in the last 30 seconds, so a serverless host with people using the app
       stays on time without any cron at all

   Checklist reminders (to the restaurant's location managers):
     - 5 minutes before a checklist opens
     - 5 minutes before it closes, if that restaurant has not sent it yet

   Label expiry (to the admins and the restaurant):
     - ACTIVE  -> EXPIRING  "expires soon"
     - any     -> EXPIRED   "has expired"
     Each change is also written to the audit log.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var windows = require('./checklistWindows');
var notify = require('./notify');
var audit = require('./audit');
var ist = require('./ist');
var restaurants = require('../config/restaurants');

var LEAD_MS = 5 * 60000;
var KICK_EVERY_MS = 30000;

function minutesText(ms) {
  var m = Math.max(1, Math.round(ms / 60000));
  return m + ' minute' + (m === 1 ? '' : 's');
}

/* --------------------------------------------------------------------------
   Checklist reminders
   -------------------------------------------------------------------------- */
function checklistReminders(now) {
  var today = windows.istParts(now).ymd;
  var jobs = [];

  windows.WINDOWS.forEach(function (win) {
    /* Opening soon: the window for today (or, just before midnight, tomorrow)
       opens within the next five minutes. */
    [today, windows.addDaysYmd(today, 1)].forEach(function (d) {
      var b = windows.shiftBounds(win, d);
      if (now >= b.startsAt - LEAD_MS && now < b.startsAt) {
        restaurants.IDS.forEach(function (loc) {
          jobs.push(notify.toRestaurant(loc, {
            kind: 'checklist.opening',
            title: win.label + ' opens in ' + minutesText(b.startsAt - now),
            body: 'Open from ' + windows.rangeLabel(win) + '. Tap to go to the checklist.',
            loc: loc, linkType: 'checklist-type', linkId: win.type,
            dedupeKey: 'cl-open:' + win.type + ':' + d
          }));
        });
      }
    });

    /* Closing soon: the window is open and ends within five minutes. Only
       restaurants that have not sent it are reminded. */
    var st = windows.windowState(win, now);
    if (st.open && now >= st.endsAt - LEAD_MS) {
      jobs.push(db.query(
        'select loc from app_checklists where checklist_type = $1 and shift_date = $2', [win.type, st.shiftDate]
      ).then(function (r) {
        var sent = r.rows.map(function (x) { return x.loc; });
        return Promise.all(restaurants.IDS.filter(function (loc) { return sent.indexOf(loc) === -1; }).map(function (loc) {
          return notify.toRestaurant(loc, {
            kind: 'checklist.closing',
            title: win.label + ' closes in ' + minutesText(st.endsAt - now),
            body: 'It has not been submitted yet. Tap to open it now.',
            loc: loc, linkType: 'checklist-type', linkId: win.type,
            dedupeKey: 'cl-close:' + win.type + ':' + st.shiftDate
          });
        }));
      }));
    }
  });

  return Promise.all(jobs);
}

/* --------------------------------------------------------------------------
   Label expiry
   -------------------------------------------------------------------------- */
function labelExpiry() {
  var labels = require('../models/labelModel');
  return labels.advanceStates().then(function (moved) {
    return Promise.all(moved.map(function (l) {
      var expMs = new Date(l.expires_at).getTime();
      var where = restaurants.nameOf(l.loc);
      var expired = l.expiry_state === 'EXPIRED';
      var n = {
        kind: expired ? 'label.expired' : 'label.expiring',
        title: expired ? 'Expired: ' + l.item_name : 'Expiring soon: ' + l.item_name,
        body: where + ' · ' + (expired ? 'expired ' : 'expires ') + ist.label(expMs) + (expired ? '. Remove it now.' : ''),
        loc: l.loc, linkType: 'label', linkId: l.id,
        /* The expiry time is in the key, so a label given a new expiry time
           is reminded again when that one comes round. */
        dedupeKey: (expired ? 'lb-expired:' : 'lb-soon:') + l.id + ':' + expMs
      };
      return Promise.all([
        notify.toAdmins(n),
        notify.toRestaurant(l.loc, n),
        audit.record(audit.SYSTEM, 'label.status', {
          loc: l.loc, entityType: 'label', entityId: l.id,
          summary: 'Label "' + l.item_name + '" at ' + where + ' is now ' + (expired ? 'Expired' : 'Expiring Soon')
        })
      ]);
    })).then(function () { return moved.length; });
  });
}

/* --------------------------------------------------------------------------
   Running it
   -------------------------------------------------------------------------- */
var running = null;
var lastRun = 0;

function tick(now) {
  if (running) return running;
  now = now || Date.now();
  lastRun = Date.now();
  running = Promise.all([
    checklistReminders(now).catch(function (err) { console.error('[scheduler] checklist reminders failed:', err.message); }),
    labelExpiry().catch(function (err) { console.error('[scheduler] label expiry failed:', err.message); return 0; })
  ]).then(function (r) {
    running = null;
    return { labelsChanged: r[1] || 0 };
  }, function (err) { running = null; throw err; });
  return running;
}

/* Starts a tick in the background unless one ran very recently. `soon`
   skips the wait, for a change that should be looked at straight away. */
function kick(soon) {
  if (running) return;
  if (!soon && Date.now() - lastRun < KICK_EVERY_MS) return;
  tick().catch(function (err) { console.error('[scheduler] tick failed:', err.message); });
}

module.exports = { tick: tick, kick: kick, checklistReminders: checklistReminders, labelExpiry: labelExpiry };
