'use strict';
/* ---------------------------------------------------------------------------
   /api/labels — labelling entries and their expiry.

     GET  /api/labels?loc=&status=&q=   admins: every restaurant (or one);
                                        users: their own restaurant only.
                                        status: ACTIVE | EXPIRING | EXPIRED
     GET  /api/labels/:id
     POST /api/labels                   { itemName, prepared, expires, photoId, notes? }
                                        prepared/expires: 'YYYY-MM-DDTHH:MM' IST.
                                        A user's label always goes to their
                                        own restaurant — the body cannot pick.
     PATCH /api/labels/:id              any of the fields above
     POST /api/labels/:id/discard       thrown away / used up: leaves the lists

   Creating a label notifies the admins. Expiring-soon and expired
   notifications come from the scheduler, not from here.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var labels = require('../models/labelModel');
var photos = require('../services/photoStore');
var access = require('../services/access');
var audit = require('../services/audit');
var notify = require('../services/notify');
var scheduler = require('../services/scheduler');
var ist = require('../services/ist');
var restaurants = require('../config/restaurants');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth, audit.withActor);

var ID_RE = /^LB-[A-F0-9]{12}$/;
var STATES = ['ACTIVE', 'EXPIRING', 'EXPIRED'];

function bad(res, message, status, code) {
  return res.status(status || 400).json({ error: message, code: code || 'VALIDATION_ERROR' });
}
function fail(message, status) {
  var err = new Error(message); err.status = status || 400; err.code = 'VALIDATION_ERROR'; err.expected = true; return err;
}

/* Checks the fields that are present. Returns { error } or { value }. */
function fields(b, creating) {
  var out = {};
  if (creating || b.itemName !== undefined) {
    var name = typeof b.itemName === 'string' ? b.itemName.replace(/\s+/g, ' ').trim() : '';
    if (!name) return { error: 'Enter the item or food name.' };
    if (name.length > 120) return { error: 'Keep the name to 120 characters or fewer.' };
    out.itemName = name;
  }
  if (creating || b.prepared !== undefined) {
    out.preparedAt = ist.parseLocal(b.prepared);
    if (!out.preparedAt) return { error: 'Choose the preparation date and time.' };
  }
  if (creating || b.expires !== undefined) {
    out.expiresAt = ist.parseLocal(b.expires);
    if (!out.expiresAt) return { error: 'Choose the expiry date and time.' };
  }
  if (b.notes !== undefined) {
    var notes = typeof b.notes === 'string' ? b.notes.trim() : '';
    if (notes.length > 500) return { error: 'Keep the notes to 500 characters or fewer.' };
    out.notes = notes;
  }
  return { value: out };
}

router.get('/', asyncHandler(function (req, res) {
  var s = access.scope(req.auth);
  if (!s.all && !s.loc) return res.json({ labels: [], counts: {}, expiringSoonHours: labels.EXPIRING_SOON_HOURS });
  var loc = s.all ? (restaurants.isRestaurant(req.query.loc) ? req.query.loc : null) : s.loc;
  var status = STATES.indexOf(req.query.status) > -1 ? req.query.status : null;
  var q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  return Promise.all([labels.list({ loc: loc, status: status, q: q }), labels.counts(loc)]).then(function (got) {
    res.set('Cache-Control', 'no-store');
    res.json({ labels: got[0], counts: got[1], expiringSoonHours: labels.EXPIRING_SOON_HOURS, serverNow: Date.now() });
  });
}));

router.get('/:id', asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
  return labels.findRow(req.params.id).then(function (row) {
    if (!row || !access.canSeeLoc(req.auth, row.loc)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store');
    res.json({ label: labels.toApi(row), expiringSoonHours: labels.EXPIRING_SOON_HOURS });
  });
}));

router.post('/', access.requireWriter, asyncHandler(function (req, res) {
  var b = req.body || {};
  /* A location manager's label belongs to their restaurant, whatever the
     request says. An admin names the restaurant. */
  var loc = access.isAdmin(req.auth) ? b.loc : req.auth.loc;
  if (!restaurants.isRestaurant(loc)) {
    return bad(res, access.isAdmin(req.auth) ? 'Choose the restaurant.' : 'Your account is not linked to a restaurant. Ask an admin to set it.');
  }
  var f = fields(b, true);
  if (f.error) return bad(res, f.error);
  var v = f.value;
  if (v.expiresAt <= v.preparedAt) return bad(res, 'The expiry time must be after the preparation time.');
  if (v.expiresAt < Date.now() - 60000) return bad(res, 'That expiry time has already passed.');
  if (!b.photoId) return bad(res, 'Take a photo of the item first.', 400, 'PHOTO_REQUIRED');

  var actor = audit.actorOf(req);
  var id = labels.newId();
  return db.transaction(function (client) {
    return photos.attach(b.photoId, req.auth.id, 'label:' + id, client).then(function (ok) {
      if (!ok) throw fail('The photo could not be used. Please take it again.');
      return labels.create({
        id: id, loc: loc, itemName: v.itemName, preparedAt: v.preparedAt, expiresAt: v.expiresAt,
        photoId: b.photoId, notes: v.notes, createdBy: req.auth.id, createdByName: actor.name
      }, client);
    }).then(function (label) {
      return audit.record(actor, 'label.create', {
        loc: loc, entityType: 'label', entityId: label.id, ip: req.ip,
        summary: 'Created label "' + label.itemName + '" at ' + label.restaurant + ', expires ' + ist.label(label.expiresAt)
      }, client).then(function () { return label; });
    });
  }).then(function (label) {
    scheduler.kick(true);           // an already-near expiry is noticed straight away
    return notify.toAdmins({
      kind: 'label.created',
      title: 'New label: ' + label.itemName,
      body: label.restaurant + ' · by ' + actor.name + ' · expires ' + ist.label(label.expiresAt),
      loc: loc, linkType: 'label', linkId: label.id
    }).then(function () { res.status(201).json({ label: label }); });
  });
}));

router.patch('/:id', access.requireWriter, asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
  var b = req.body || {};
  var f = fields(b, false);
  if (f.error) return bad(res, f.error);
  var v = f.value;
  var actor = audit.actorOf(req);

  return labels.findRow(req.params.id).then(function (row) {
    if (!row || !access.canSeeLoc(req.auth, row.loc)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
    if (row.discarded_at) return bad(res, 'This label has already been removed.', 409, 'DISCARDED');
    var prepared = v.preparedAt !== undefined ? v.preparedAt : new Date(row.prepared_at).getTime();
    var expires = v.expiresAt !== undefined ? v.expiresAt : new Date(row.expires_at).getTime();
    if (expires <= prepared) return bad(res, 'The expiry time must be after the preparation time.');

    return db.transaction(function (client) {
      var attach = b.photoId
        ? photos.attach(b.photoId, req.auth.id, 'label:' + row.id, client).then(function (ok) {
            if (!ok) throw fail('The photo could not be used. Please take it again.');
            v.photoId = b.photoId;
          })
        : Promise.resolve();
      return attach.then(function () { return labels.update(row.id, v, actor.name, client); }).then(function (label) {
        if (!label) throw fail('This label has already been removed.', 409);
        var changed = Object.keys(v).map(function (k) {
          return { itemName: 'name', preparedAt: 'preparation time', expiresAt: 'expiry time', notes: 'notes', photoId: 'photo' }[k];
        }).join(', ');
        return audit.record(actor, 'label.update', {
          loc: label.loc, entityType: 'label', entityId: label.id, ip: req.ip,
          summary: 'Updated label "' + label.itemName + '" at ' + label.restaurant + (changed ? ' (' + changed + ')' : '')
        }, client).then(function () { return label; });
      });
    }).then(function (label) {
      scheduler.kick(true);
      res.json({ label: label });
    });
  });
}));

router.post('/:id/discard', access.requireWriter, asyncHandler(function (req, res) {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
  var actor = audit.actorOf(req);
  return labels.findRow(req.params.id).then(function (row) {
    if (!row || !access.canSeeLoc(req.auth, row.loc)) return bad(res, 'Label not found', 404, 'NOT_FOUND');
    return labels.discard(row.id, actor.name).then(function (label) {
      if (!label) return bad(res, 'This label has already been removed.', 409, 'DISCARDED');
      return audit.record(actor, 'label.discard', {
        loc: label.loc, entityType: 'label', entityId: label.id, ip: req.ip,
        summary: 'Removed label "' + label.itemName + '" at ' + label.restaurant + ' (' +
          (label.status === 'EXPIRED' ? 'expired item thrown away' : 'used up or thrown away') + ')'
      }).then(function () { res.json({ label: label }); });
    });
  });
}));

module.exports = router;
