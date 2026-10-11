'use strict';
/* ---------------------------------------------------------------------------
   Cleaning tasks (app_cleaning_tasks) — every read and write goes here.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');
var photos = require('../services/photoStore');
var restaurants = require('../config/restaurants');

var COLUMNS =
  'id, title, loc, instructions, due_at, ref_photo_id, status, created_by_name, created_at, ' +
  'completed_by_name, completed_at, completion_photo_id, completion_note, updated_at';

function newId() { return 'CT-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function ms(v) { return v ? new Date(v).getTime() : null; }

/* Row -> API shape. Photo links are signed here, so only someone who was
   allowed to read the task ever receives one. */
function toApi(row) {
  if (!row) return null;
  var due = ms(row.due_at);
  return {
    id: row.id,
    title: row.title,
    loc: row.loc,
    restaurant: restaurants.nameOf(row.loc),
    instructions: row.instructions || '',
    dueAt: due,
    status: row.status,
    overdue: row.status === 'PENDING' && due < Date.now(),
    refPhotoUrl: photos.urlFor(row.ref_photo_id),
    createdByName: row.created_by_name,
    createdAt: ms(row.created_at),
    completedByName: row.completed_by_name,
    completedAt: ms(row.completed_at),
    completionPhotoUrl: photos.urlFor(row.completion_photo_id),
    completionNote: row.completion_note || '',
    updatedAt: ms(row.updated_at)
  };
}

function create(t, client) {
  return (client || db).query(
    'insert into app_cleaning_tasks (id, title, loc, instructions, due_at, ref_photo_id, created_by, created_by_name) ' +
    'values ($1, $2, $3, $4, $5, $6, $7, $8) returning ' + COLUMNS,
    [t.id || newId(), t.title, t.loc, t.instructions || null, new Date(t.dueAt), t.refPhotoId || null, t.createdBy, t.createdByName]
  ).then(function (r) { return toApi(r.rows[0]); });
}

function findById(id) {
  return db.query('select ' + COLUMNS + ' from app_cleaning_tasks where id = $1', [id])
    .then(function (r) { return r.rows[0] || null; });
}

/* opts: { loc, status: 'PENDING'|'DONE'|'OVERDUE'|null, limit } */
function list(opts) {
  var params = [], where = [];
  if (opts.loc) { params.push(opts.loc); where.push('loc = $' + params.length); }
  if (opts.status === 'OVERDUE') where.push("status = 'PENDING' and due_at < now()");
  else if (opts.status) { params.push(opts.status); where.push('status = $' + params.length); }
  params.push(Math.min(500, opts.limit || 300));
  /* Pending first, soonest due at the top; then what was done most recently. */
  return db.query(
    'select ' + COLUMNS + ' from app_cleaning_tasks ' + (where.length ? 'where ' + where.join(' and ') + ' ' : '') +
    "order by (status = 'DONE'), case when status = 'PENDING' then due_at end asc, completed_at desc nulls last " +
    'limit $' + params.length, params
  ).then(function (r) { return r.rows.map(toApi); });
}

/* Resolves to the updated row, or null when it was not PENDING any more (two
   phones marking it done at once: the first one wins). */
function complete(id, done, client) {
  return (client || db).query(
    "update app_cleaning_tasks set status = 'DONE', completed_by = $2, completed_by_name = $3, completed_at = now(), " +
    'completion_photo_id = $4, completion_note = $5, updated_at = now() ' +
    "where id = $1 and status = 'PENDING' returning " + COLUMNS,
    [id, done.userId, done.userName, done.photoId, done.note || null]
  ).then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

/* The task and its photos go together. */
function remove(id) {
  return db.transaction(function (client) {
    return client.query('delete from app_cleaning_tasks where id = $1 returning id, title, loc', [id]).then(function (r) {
      if (!r.rows[0]) return null;
      return client.query('delete from app_photos where attached_to = $1 returning url', ['task:' + id]).then(function (p) {
        var gone = r.rows[0];
        gone.photoUrls = p.rows.map(function (x) { return x.url; }).filter(Boolean);
        return gone;
      });
    });
  }).then(function (gone) {
    if (gone) photos.deleteBlobs(gone.photoUrls);
    return gone;
  });
}

module.exports = { newId: newId, toApi: toApi, create: create, findById: findById, list: list, complete: complete, remove: remove };
