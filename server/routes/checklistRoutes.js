'use strict';
/* ---------------------------------------------------------------------------
   /api/checklists — Lunch, Dinner and Closing checklists.

   The window is decided HERE, from the server's clock in IST (12:00–13:30,
   17:00–18:00, 22:00–01:00). The browser's clock and its opinion of "open"
   are never trusted, so changing the device time or editing the page's
   JavaScript gets a 403, not a record.

   Endpoints:
     GET    /api/checklists/status        windows right now + what was sent (everyone)
     GET    /api/checklists/items?type=   the items each checklist asks (everyone)
     POST   /api/checklists/items         admin: add { type, text, required, photoRequired }
     PATCH  /api/checklists/items/:id     admin: change any of those
     POST   /api/checklists/items/:id/move  admin: { dir: -1 | 1 }
     DELETE /api/checklists/items/:id     admin: remove (kept for past records)
     GET    /api/checklists/board?from&to&loc&type&status
                                          Pending / Submitted / Missed per
                                          restaurant, checklist and day
     POST   /api/checklists               submit. Two shapes are accepted:
                                            { type, loc?, items: [{ id, done, photoId? }] }
                                            { type, loc?, answers: [true, false, …] }  (older apps)
     GET    /api/checklists?from&to&loc&type   submitted records
     GET    /api/checklists/:id           one record, with its photos

   Who sees what: admins every restaurant; a location manager their own.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var checklists = require('../models/checklistModel');
var itemModel = require('../models/checklistItemModel');
var windows = require('../services/checklistWindows');
var legacyItems = require('../services/checklistItems');
var photos = require('../services/photoStore');
var access = require('../services/access');
var audit = require('../services/audit');
var notify = require('../services/notify');
var settings = require('../services/settings');
var restaurants = require('../config/restaurants');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth);

var YMD = /^\d{4}-\d{2}-\d{2}$/;
var ITEM_ID = /^CI-[A-F0-9]{12}$/;
var MAX_BOARD_DAYS = 62;

function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code || 'VALIDATION_ERROR' });
}
function failure(message, status, code) {
  var err = new Error(message); err.status = status || 400; err.code = code || 'VALIDATION_ERROR'; err.expected = true; return err;
}

/* ---------------------------------------------------------------------------
   GET /status
   --------------------------------------------------------------------------- */
router.get('/status', asyncHandler(function (req, res) {
  var now = Date.now();
  var states = windows.allStates(now);
  var dates = [];
  states.forEach(function (s) { if (dates.indexOf(s.shiftDate) === -1) dates.push(s.shiftDate); });

  /* Each restaurant sends each checklist once, whoever sends it, so what
     matters is what has been sent for the restaurants this person covers. */
  var s = access.scope(req.auth);
  var load = s.all || s.loc
    ? checklists.listForShifts(dates, s.all ? null : s.loc)
    : checklists.listForUser(req.auth.id, dates);

  return load.then(function (sent) {
    var out = states.map(function (st) {
      var subs = sent.filter(function (m) { return m.type === st.type && m.shiftDate === st.shiftDate; });
      return {
        type: st.type, label: st.label, open: st.open, shiftDate: st.shiftDate,
        startsAt: st.startsAt, endsAt: st.endsAt, nextOpensAt: st.nextOpensAt,
        submissions: subs,
        submission: subs.filter(function (m) { return m.userId === req.auth.id; })[0] ||
          (s.loc ? subs.filter(function (m) { return m.loc === s.loc; })[0] || null : null)
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ serverNow: now, timeZone: 'Asia/Kolkata', windows: out });
  });
}));

/* ---------------------------------------------------------------------------
   Items — what each checklist asks
   --------------------------------------------------------------------------- */
router.get('/items', asyncHandler(function (req, res) {
  var type = itemModel.TYPES.indexOf(req.query.type) > -1 ? req.query.type : null;
  return itemModel.listActive(type).then(function (list) {
    res.set('Cache-Control', 'no-store');
    res.json({ items: list });
  });
}));

function itemFields(b, creating) {
  var out = {};
  if (creating) {
    if (itemModel.TYPES.indexOf(b.type) === -1) return { error: 'Choose Lunch, Dinner or Closing.' };
    out.type = b.type;
  }
  if (creating || b.text !== undefined) {
    var text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { error: 'Enter what needs to be checked.' };
    if (text.length > 300) return { error: 'Keep it to 300 characters or fewer.' };
    out.text = text;
  }
  if (b.required !== undefined) out.required = b.required === true;
  if (b.photoRequired !== undefined) out.photoRequired = b.photoRequired === true;
  return { value: out };
}

var TYPE_LABEL = { LUNCH: 'Lunch', DINNER: 'Dinner', CLOSING: 'Closing' };

router.post('/items', access.requireAdminWriter, audit.withActor, asyncHandler(function (req, res) {
  var f = itemFields(req.body || {}, true);
  if (f.error) return fail(res, 400, f.error);
  var actor = audit.actorOf(req);
  return itemModel.create(f.value, actor.name).then(function (item) {
    return audit.record(actor, 'checklist.item.add', {
      entityType: 'checklist-item', entityId: item.id, ip: req.ip,
      summary: 'Added to the ' + TYPE_LABEL[item.type] + ' checklist: "' + item.text + '"' +
        (item.photoRequired ? ' (photo required)' : '') + (item.required ? '' : ' (optional)')
    }).then(function () { res.status(201).json({ item: item }); });
  });
}));

router.patch('/items/:id', access.requireAdminWriter, audit.withActor, asyncHandler(function (req, res) {
  if (!ITEM_ID.test(req.params.id)) return fail(res, 404, 'Item not found', 'NOT_FOUND');
  var f = itemFields(req.body || {}, false);
  if (f.error) return fail(res, 400, f.error);
  var actor = audit.actorOf(req);
  return itemModel.update(req.params.id, f.value, actor.name).then(function (item) {
    if (!item) return fail(res, 404, 'Item not found', 'NOT_FOUND');
    return audit.record(actor, 'checklist.item.edit', {
      entityType: 'checklist-item', entityId: item.id, ip: req.ip,
      summary: 'Changed a ' + TYPE_LABEL[item.type] + ' checklist item: "' + item.text + '" — ' +
        (item.required ? 'required' : 'optional') + ', photo ' + (item.photoRequired ? 'required' : 'not required')
    }).then(function () { res.json({ item: item }); });
  });
}));

router.post('/items/:id/move', access.requireAdminWriter, audit.withActor, asyncHandler(function (req, res) {
  if (!ITEM_ID.test(req.params.id)) return fail(res, 404, 'Item not found', 'NOT_FOUND');
  var dir = req.body && req.body.dir === -1 ? -1 : 1;
  return itemModel.move(req.params.id, dir, audit.actorOf(req).name).then(function (ok) {
    if (!ok) return fail(res, 404, 'Item not found', 'NOT_FOUND');
    res.json({ ok: true });
  });
}));

router.delete('/items/:id', access.requireAdminWriter, audit.withActor, asyncHandler(function (req, res) {
  if (!ITEM_ID.test(req.params.id)) return fail(res, 404, 'Item not found', 'NOT_FOUND');
  var actor = audit.actorOf(req);
  return itemModel.remove(req.params.id, actor.name).then(function (item) {
    if (!item) return fail(res, 404, 'Item not found', 'NOT_FOUND');
    return audit.record(actor, 'checklist.item.remove', {
      entityType: 'checklist-item', entityId: item.id, ip: req.ip,
      summary: 'Removed from the ' + TYPE_LABEL[item.type] + ' checklist: "' + item.text + '"'
    }).then(function () { res.json({ ok: true }); });
  });
}));

/* ---------------------------------------------------------------------------
   GET /board — Pending / Submitted / Missed, one row per restaurant,
   checklist and day.

     SUBMITTED  a record exists
     PENDING    open now and not sent yet (a checklist that has not opened
                yet is not listed at all)
     MISSED     not sent and the window has closed. Days before the app began
                tracking (app_settings.checklist_tracking_since) are left out.
   --------------------------------------------------------------------------- */
router.get('/board', asyncHandler(function (req, res) {
  var s = access.scope(req.auth);
  if (!s.all && !s.loc) return res.json({ rows: [], counts: { SUBMITTED: 0, PENDING: 0, MISSED: 0 } });

  var now = Date.now();
  var today = windows.istParts(now).ymd;
  var from = YMD.test(req.query.from || '') ? req.query.from : today;
  var to = YMD.test(req.query.to || '') ? req.query.to : from;
  if (from > to) { var t = from; from = to; to = t; }
  if (windows.addDaysYmd(from, MAX_BOARD_DAYS) < to) from = windows.addDaysYmd(to, -MAX_BOARD_DAYS);

  var locs = s.all ? (restaurants.isRestaurant(req.query.loc) ? [req.query.loc] : restaurants.IDS) : [s.loc];
  var types = itemModel.TYPES.indexOf(req.query.type) > -1 ? [req.query.type] : itemModel.TYPES;
  var wantStatus = ['SUBMITTED', 'PENDING', 'MISSED'].indexOf(req.query.status) > -1 ? req.query.status : null;

  return Promise.all([
    checklists.list({ from: from, to: to, loc: locs.length === 1 ? locs[0] : null }),
    settings.get('checklist_tracking_since', today)
  ]).then(function (got) {
    var byKey = {};
    got[0].forEach(function (r) { byKey[r.loc + '|' + r.type + '|' + r.shiftDate] = r; });
    var since = got[1];

    var rows = [], counts = { SUBMITTED: 0, PENDING: 0, MISSED: 0 };
    for (var d = to; d >= from; d = windows.addDaysYmd(d, -1)) {
      types.forEach(function (type) {
        var win = windows.byType(type);
        var b = windows.shiftBounds(win, d);
        locs.forEach(function (loc) {
          var sub = byKey[loc + '|' + type + '|' + d] || null;
          var status;
          /* A checklist is listed from the moment it opens, not before. */
          if (!sub && now < b.startsAt) return;
          if (sub) status = 'SUBMITTED';
          else if (now < b.endsAt) status = 'PENDING';
          else if (d >= since) status = 'MISSED';
          else return;                                  // before tracking began
          counts[status]++;
          if (wantStatus && wantStatus !== status) return;
          rows.push({
            date: d, type: type, label: win.label, loc: loc, restaurant: restaurants.nameOf(loc),
            status: status, open: !sub && now >= b.startsAt && now < b.endsAt,
            startsAt: b.startsAt, endsAt: b.endsAt,
            submission: sub ? { id: sub.id, userName: sub.userName, submittedAt: sub.submittedAt, ticked: sub.ticked, total: sub.total, photos: sub.photos } : null
          });
        });
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ from: from, to: to, serverNow: now, rows: rows, counts: counts });
  });
}));

/* ---------------------------------------------------------------------------
   POST /   submit a checklist
   --------------------------------------------------------------------------- */
router.post('/', access.requireWriter, audit.withActor, asyncHandler(function (req, res) {
  var body = req.body || {};
  var type = String(body.type || '').toUpperCase();
  var win = windows.byType(type);
  if (!win) return fail(res, 400, 'Choose Lunch, Dinner or Closing.');

  /* The time check comes before anything else that could succeed. */
  var now = Date.now();
  var state = windows.windowState(win, now);
  if (!state.open) {
    return fail(res, 403, win.label + ' is currently unavailable. Available from ' +
      windows.rangeLabel(win) + '.', 'CHECKLIST_CLOSED');
  }

  /* A location manager is pinned to their own restaurant by their signed
     token. An admin names the restaurant they are filling it in for. */
  var loc = req.auth.loc || null;
  if (access.isAdmin(req.auth)) {
    loc = restaurants.isRestaurant(body.loc) ? body.loc : null;
    if (!loc) return fail(res, 400, 'Choose the restaurant this checklist is for.');
  }
  if (!loc) return fail(res, 400, 'Your account is not linked to a restaurant. Ask an admin to set it.');

  var id = checklists.newId();
  var actor = audit.actorOf(req);

  /* Already sent for this restaurant and shift? Say so before checking the
     answers, so a second phone is told the truth rather than "add a photo". */
  var notYetSent = checklists.listForShifts([state.shiftDate], loc).then(function (sent) {
    if (sent.some(function (m) { return m.type === type; })) throw failure('ALREADY', 409, 'ALREADY_SUBMITTED');
  });

  /* Work out the answers to store, checking required items and photos. */
  var answersP;
  if (Array.isArray(body.items)) {
    answersP = notYetSent.then(function () { return itemModel.listActive(type); }).then(function (list) {
      var given = {};
      body.items.forEach(function (x) { if (x && typeof x.id === 'string') given[x.id] = x; });
      var missing = [], noPhoto = [];
      var answers = list.map(function (it) {
        var g = given[it.id] || {};
        var done = g.done === true;
        var photoId = typeof g.photoId === 'string' && g.photoId ? g.photoId : null;
        if (it.required && !done) missing.push(it.text);
        if (it.photoRequired && !photoId) noPhoto.push(it.text);
        return { itemId: it.id, section: null, question: it.text, done: done,
          required: it.required, photoRequired: it.photoRequired, photoId: photoId };
      });
      if (missing.length) throw failure('Tick every required item before submitting. Still to do: ' + missing.slice(0, 3).join('; ') + (missing.length > 3 ? ' …' : ''), 400, 'ITEMS_REQUIRED');
      if (noPhoto.length) throw failure('Add the required photos before submitting. Photo needed for: ' + noPhoto.slice(0, 3).join('; ') + (noPhoto.length > 3 ? ' …' : ''), 400, 'PHOTO_REQUIRED');
      return answers;
    });
  } else {
    /* Older apps send one boolean per question of the original form. */
    var ticked = legacyItems.check(body.answers);
    answersP = notYetSent.then(function () {
      if (ticked.error) throw failure(ticked.error);
      return ticked.answers;
    });
  }

  return answersP.then(function (answers) {
    return db.transaction(function (client) {
      var withPhotos = answers.filter(function (a) { return a.photoId; });
      return withPhotos.reduce(function (p, a) {
        return p.then(function () {
          return photos.attach(a.photoId, req.auth.id, 'checklist:' + id, client).then(function (ok) {
            if (!ok) throw failure('A photo could not be used. Please take it again: ' + a.question, 400, 'PHOTO_REQUIRED');
          });
        });
      }, Promise.resolve()).then(function () {
        return checklists.create({
          id: id, userId: req.auth.id, userName: actor.name, loc: loc, type: type,
          shiftDate: state.shiftDate, startTime: state.startsAt, endTime: state.endsAt,
          /* The same instant the window was judged at, so a record can never
             show a submission time outside its own window. */
          submittedAt: now,
          answers: answers
        }, client);
      }).then(function (rec) {
        if (!rec) throw failure('ALREADY', 409, 'ALREADY_SUBMITTED');
        return audit.record(actor, 'checklist.submit', {
          loc: loc, entityType: 'checklist', entityId: rec.id, ip: req.ip,
          summary: 'Submitted the ' + win.label + ' for ' + restaurants.nameOf(loc) + ' (' + rec.ticked + ' of ' + rec.total + ' items ticked' +
            (rec.photos ? ', ' + rec.photos + ' photo' + (rec.photos === 1 ? '' : 's') : '') + ')'
        }, client).then(function () { return rec; });
      });
    });
  }).then(function (rec) {
    console.log('[checklist] ' + req.auth.uid + ' submitted ' + type + ' for ' + state.shiftDate + ' at ' + loc);
    return notify.toAdmins({
      kind: 'checklist.submitted',
      title: win.label + ' submitted',
      body: restaurants.nameOf(loc) + ' · by ' + actor.name,
      loc: loc, linkType: 'checklist', linkId: rec.id
    }).then(function () { res.status(201).json({ checklist: rec }); });
  }, function (err) {
    if (err.code !== 'ALREADY_SUBMITTED') throw err;
    /* This restaurant already sent it this shift: hand back that record. */
    return checklists.listForShifts([state.shiftDate], loc).then(function (sent) {
      var existing = sent.filter(function (m) { return m.type === type; })[0] || null;
      res.status(409).json({
        error: 'The ' + win.label + ' for this restaurant has already been submitted for this shift' +
          (existing && existing.userName ? ' by ' + existing.userName : '') + '.',
        code: 'ALREADY_SUBMITTED',
        checklist: existing
      });
    });
  });
}));

/* ---------------------------------------------------------------------------
   GET /?from=YYYY-MM-DD&to=YYYY-MM-DD&loc=&type=
   --------------------------------------------------------------------------- */
router.get('/', asyncHandler(function (req, res) {
  var today = windows.istParts(Date.now()).ymd;
  var from = YMD.test(req.query.from || '') ? req.query.from : windows.addDaysYmd(today, -6);
  var to = YMD.test(req.query.to || '') ? req.query.to : today;
  if (from > to) { var t = from; from = to; to = t; }
  var type = itemModel.TYPES.indexOf(req.query.type) > -1 ? req.query.type : null;

  var s = access.scope(req.auth);
  var opts = { from: from, to: to, type: type };
  if (s.all) opts.loc = restaurants.isRestaurant(req.query.loc) ? req.query.loc : null;
  else if (s.loc) opts.loc = s.loc;
  else opts.userId = req.auth.id;

  return checklists.list(opts).then(function (rows) {
    res.set('Cache-Control', 'no-store');
    res.json({ from: from, to: to, checklists: rows });
  });
}));

/* ---------------------------------------------------------------------------
   GET /:id — one record
   --------------------------------------------------------------------------- */
router.get('/:id', asyncHandler(function (req, res) {
  var id = String(req.params.id || '');
  if (!/^CL-[A-F0-9]{12}$/.test(id)) return fail(res, 400, 'Invalid checklist id', 'INVALID_ID');

  return checklists.findById(id).then(function (rec) {
    if (!rec) return fail(res, 404, 'Not found', 'NOT_FOUND');
    var own = rec.userId === req.auth.id;
    if (!own && !access.canSeeLoc(req.auth, rec.loc)) return fail(res, 404, 'Not found', 'NOT_FOUND');
    res.set('Cache-Control', 'no-store');
    res.json({ checklist: rec, restaurant: restaurants.nameOf(rec.loc) });
  });
}));

module.exports = router;
