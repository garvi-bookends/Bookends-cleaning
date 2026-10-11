'use strict';
/* ---------------------------------------------------------------------------
   Audit log — who did what, at which restaurant, and when.

   Writes to app_admin_audit, the same table that has always held the wipe
   record. A wipe never deletes from it.

   record() never throws: an action that has already happened must not be
   reported as failed because writing its audit line did. A failure is
   logged loudly instead.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');

/* actor: { id, uid, role, name } — usually from actorOf(req). Pass
   SYSTEM for changes the scheduler makes on its own (expiry status). */
var SYSTEM = { id: null, uid: 'system', role: 'system', name: 'System' };

function record(actor, action, fields, client) {
  fields = fields || {};
  actor = actor || SYSTEM;
  return (client || db).query(
    'insert into app_admin_audit (action, actor_id, actor_uid, actor_role, actor_name, ip, loc, entity_type, entity_id, summary, detail) ' +
    'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [action, actor.id || null, actor.uid || null, actor.role || null, actor.name || null,
      fields.ip || null, fields.loc || null, fields.entityType || null, fields.entityId || null,
      fields.summary ? String(fields.summary).slice(0, 500) : null,
      fields.detail ? JSON.stringify(fields.detail) : null]
  ).catch(function (err) {
    console.error('[audit] could not record ' + action + ':', err.message);
    if (client) throw err;          // inside a transaction the caller decides
  });
}

/* The signed-in person, with their display name (set by withActor). */
function actorOf(req) {
  return { id: req.auth.id, uid: req.auth.uid, role: req.auth.role, name: req.actorName || req.auth.uid };
}

/* Middleware: looks the person up once so routes can stamp names on the
   records they write and on the audit line. A disabled or pending account
   still holding an unexpired token is turned away here. */
var userModel = require('../models/userModel');
function withActor(req, res, next) {
  userModel.findById(req.auth.id).then(function (u) {
    if (!u || u.disabled || u.pending) {
      return res.status(401).json({ error: 'Sign in to continue', code: 'UNAUTHORIZED' });
    }
    req.actorName = u.name;
    next();
  }, next);
}

function list(opts) {
  var params = [], where = [];
  if (opts.loc) { params.push(opts.loc); where.push('loc = $' + params.length); }
  if (opts.action) { params.push(opts.action + '%'); where.push('action like $' + params.length); }
  if (opts.from) { params.push(opts.from); where.push('at >= $' + params.length); }
  if (opts.to) { params.push(opts.to); where.push('at < $' + params.length); }
  if (opts.before) { params.push(opts.before); where.push('id < $' + params.length); }
  params.push(Math.min(200, Math.max(1, opts.limit || 100)));
  return db.query(
    'select id, at, action, actor_uid, actor_role, actor_name, loc, entity_type, entity_id, summary, detail from app_admin_audit ' +
    (where.length ? 'where ' + where.join(' and ') + ' ' : '') +
    'order by id desc limit $' + params.length, params
  ).then(function (r) {
    return r.rows.map(function (row) {
      return {
        id: Number(row.id), at: new Date(row.at).getTime(), action: row.action,
        actorUid: row.actor_uid, actorRole: row.actor_role, actorName: row.actor_name || row.actor_uid,
        loc: row.loc, entityType: row.entity_type, entityId: row.entity_id,
        summary: row.summary || defaultSummary(row)
      };
    });
  });
}

/* Wipe rows written before this log had a summary column. */
function defaultSummary(row) {
  if (row.action === 'wipe') return 'Wiped all application data';
  return row.action;
}

module.exports = { SYSTEM: SYSTEM, record: record, actorOf: actorOf, withActor: withActor, list: list };
