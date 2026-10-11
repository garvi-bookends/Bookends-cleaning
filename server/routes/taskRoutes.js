'use strict';
/* ---------------------------------------------------------------------------
   /api/tasks — cleaning tasks.

     GET    /api/tasks?loc=&status=   admins: every restaurant (or one);
                                      users: their own restaurant only
     GET    /api/tasks/:id            one task (same rule)
     POST   /api/tasks                admin: create and send
                                      { title, loc, instructions, due, refPhotoId? }
                                      'due' is 'YYYY-MM-DDTHH:MM' in IST
     POST   /api/tasks/:id/complete   the restaurant's user (or an admin):
                                      { photoId, note? } — the photo is required
     DELETE /api/tasks/:id            admin

   Sending a task notifies that restaurant's location manager(s); completing
   one notifies the admins. Both are written to the audit log.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var tasks = require('../models/taskModel');
var photos = require('../services/photoStore');
var access = require('../services/access');
var audit = require('../services/audit');
var notify = require('../services/notify');
var ist = require('../services/ist');
var restaurants = require('../config/restaurants');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth, audit.withActor);

var ID_RE = /^CT-[A-F0-9]{12}$/;

function bad(res, message, status, code) {
  return res.status(status || 400).json({ error: message, code: code || 'VALIDATION_ERROR' });
}
function clean(v, max) {
  return typeof v === 'string' ? v.replace(/[ \t]+/g, ' ').trim().slice(0, max + 1) : '';
}
function fail(message, status) {
  var err = new Error(message); err.status = status || 400; err.code = 'VALIDATION_ERROR'; err.expected = true; return err;
}

router.get('/', asyncHandler(function (req, res) {
  var s = access.scope(req.auth);
  if (!s.all && !s.loc) return res.json({ tasks: [] });
  var loc = s.all ? (restaurants.isRestaurant(req.query.loc) ? req.query.loc : null) : s.loc;
  var status = ['PENDING', 'DONE', 'OVERDUE'].indexOf(req.query.status) > -1 ? req.query.status : null;
  return tasks.list({ loc: loc, status: status }).then(function (list) {
    res.set('Cache-Control', 'no-store');
    res.json({ tasks: list, serverNow: Date.now() });
  });
}));

router.get('/:id', asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Task not found', 404, 'NOT_FOUND');
  return tasks.findById(req.params.id).then(function (row) {
    if (!row || !access.canSeeLoc(req.auth, row.loc)) return bad(res, 'Task not found', 404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store');
    res.json({ task: tasks.toApi(row) });
  });
}));

router.post('/', access.requireAdminWriter, asyncHandler(function (req, res) {
  var b = req.body || {};
  var title = clean(b.title, 120);
  var instructions = typeof b.instructions === 'string' ? b.instructions.trim() : '';
  var dueAt = ist.parseLocal(b.due);

  if (!title) return bad(res, 'Enter the task name.');
  if (title.length > 120) return bad(res, 'Keep the task name to 120 characters or fewer.');
  if (!restaurants.isRestaurant(b.loc)) return bad(res, 'Choose the restaurant.');
  if (instructions.length > 2000) return bad(res, 'Keep the instructions to 2000 characters or fewer.');
  if (!dueAt) return bad(res, 'Choose the due date and time.');
  if (dueAt < Date.now() - 60000) return bad(res, 'The due date and time has already passed.');

  var actor = audit.actorOf(req);
  var id = tasks.newId();

  return db.transaction(function (client) {
    var attach = b.refPhotoId
      ? photos.attach(b.refPhotoId, req.auth.id, 'task:' + id, client).then(function (ok) {
          if (!ok) throw fail('The reference photo could not be used. Please add it again.');
        })
      : Promise.resolve();
    return attach.then(function () {
      return tasks.create({
        id: id, title: title, loc: b.loc, instructions: instructions, dueAt: dueAt,
        refPhotoId: b.refPhotoId || null, createdBy: req.auth.id, createdByName: actor.name
      }, client);
    }).then(function (task) {
      return audit.record(actor, 'task.create', {
        loc: task.loc, entityType: 'task', entityId: task.id, ip: req.ip,
        summary: 'Sent cleaning task "' + task.title + '" to ' + task.restaurant + ', due ' + ist.label(task.dueAt)
      }, client).then(function () { return task; });
    });
  }).then(function (task) {
    return notify.toRestaurant(task.loc, {
      kind: 'task.assigned',
      title: 'New cleaning task: ' + task.title,
      body: 'Due ' + ist.label(task.dueAt) + '. Tap to open it.',
      loc: task.loc, linkType: 'task', linkId: task.id
    }).then(function (n) {
      console.log('[tasks] ' + req.auth.uid + ' sent ' + task.id + ' to ' + task.loc + ' (' + n + ' notified)');
      res.status(201).json({ task: task, notified: n });
    });
  });
}));

router.post('/:id/complete', access.requireWriter, asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Task not found', 404, 'NOT_FOUND');
  var b = req.body || {};
  var note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > 500) return bad(res, 'Keep the note to 500 characters or fewer.');
  if (!b.photoId) return bad(res, 'Take a photo of the finished work first.', 400, 'PHOTO_REQUIRED');

  var actor = audit.actorOf(req);
  return tasks.findById(req.params.id).then(function (row) {
    if (!row || !access.canSeeLoc(req.auth, row.loc)) return bad(res, 'Task not found', 404, 'NOT_FOUND');
    if (row.status === 'DONE') return bad(res, 'This task has already been marked as done.', 409, 'ALREADY_DONE');

    return db.transaction(function (client) {
      return photos.attach(b.photoId, req.auth.id, 'task:' + row.id, client).then(function (ok) {
        if (!ok) throw fail('The photo could not be used. Please take it again.');
        return tasks.complete(row.id, { userId: req.auth.id, userName: actor.name, photoId: b.photoId, note: note }, client);
      }).then(function (task) {
        if (!task) throw fail('This task has already been marked as done.', 409);
        return audit.record(actor, 'task.complete', {
          loc: task.loc, entityType: 'task', entityId: task.id, ip: req.ip,
          summary: 'Completed cleaning task "' + task.title + '" at ' + task.restaurant + (task.overdue || task.completedAt > task.dueAt ? ' (after the due time)' : '')
        }, client).then(function () { return task; });
      });
    }).then(function (task) {
      return notify.toAdmins({
        kind: 'task.completed',
        title: 'Task done: ' + task.title,
        body: task.restaurant + ' · by ' + actor.name + ' · ' + ist.label(task.completedAt),
        loc: task.loc, linkType: 'task', linkId: task.id
      }).then(function () { res.json({ task: task }); });
    });
  });
}));

router.delete('/:id', access.requireAdminWriter, asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Task not found', 404, 'NOT_FOUND');
  return tasks.remove(req.params.id).then(function (gone) {
    if (!gone) return bad(res, 'Task not found', 404, 'NOT_FOUND');
    return audit.record(audit.actorOf(req), 'task.delete', {
      loc: gone.loc, entityType: 'task', entityId: gone.id, ip: req.ip,
      summary: 'Deleted cleaning task "' + gone.title + '" (' + restaurants.nameOf(gone.loc) + ')'
    }).then(function () { res.json({ ok: true }); });
  });
}));

module.exports = router;
