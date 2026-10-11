'use strict';
/* ---------------------------------------------------------------------------
   Labels (app_labels) — every read and write goes here.

   Status is worked out from expires_at every time a label is read:
     EXPIRED   the expiry time has passed
     EXPIRING  it expires within EXPIRING_SOON_HOURS
     ACTIVE    otherwise
   The scheduler separately keeps expiry_state up to date so that each change
   is logged and notified exactly once (see services/scheduler.js).
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');
var photos = require('../services/photoStore');
var restaurants = require('../config/restaurants');

var EXPIRING_SOON_HOURS = 24;
var SOON_MS = EXPIRING_SOON_HOURS * 3600000;

var COLUMNS =
  'id, loc, item_name, prepared_at, expires_at, photo_id, notes, expiry_state, created_by_name, created_at, ' +
  'updated_by_name, updated_at, discarded_at, discarded_by_name';

function newId() { return 'LB-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function ms(v) { return v ? new Date(v).getTime() : null; }

function stateAt(expiresMs, now) {
  if (expiresMs <= now) return 'EXPIRED';
  if (expiresMs - now <= SOON_MS) return 'EXPIRING';
  return 'ACTIVE';
}

/* The same rule in SQL, for counting and filtering in the database. */
var STATE_SQL =
  "case when expires_at <= now() then 'EXPIRED' " +
  "when expires_at <= now() + interval '" + EXPIRING_SOON_HOURS + " hours' then 'EXPIRING' else 'ACTIVE' end";

function toApi(row) {
  if (!row) return null;
  var exp = ms(row.expires_at);
  return {
    id: row.id,
    loc: row.loc,
    restaurant: restaurants.nameOf(row.loc),
    itemName: row.item_name,
    preparedAt: ms(row.prepared_at),
    expiresAt: exp,
    status: stateAt(exp, Date.now()),
    photoUrl: photos.urlFor(row.photo_id),
    notes: row.notes || '',
    createdByName: row.created_by_name,
    createdAt: ms(row.created_at),
    updatedByName: row.updated_by_name,
    updatedAt: ms(row.updated_at),
    discardedAt: ms(row.discarded_at),
    discardedByName: row.discarded_by_name
  };
}

function create(l, client) {
  return (client || db).query(
    'insert into app_labels (id, loc, item_name, prepared_at, expires_at, photo_id, notes, created_by, created_by_name) ' +
    'values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ' + COLUMNS,
    [l.id, l.loc, l.itemName, new Date(l.preparedAt), new Date(l.expiresAt), l.photoId || null, l.notes || null, l.createdBy, l.createdByName]
  ).then(function (r) { return toApi(r.rows[0]); });
}

function findRow(id) {
  return db.query('select ' + COLUMNS + ' from app_labels where id = $1', [id]).then(function (r) { return r.rows[0] || null; });
}

/* opts: { loc, status, q, includeDiscarded, limit } */
function list(opts) {
  var params = [], where = [];
  if (!opts.includeDiscarded) where.push('discarded_at is null');
  if (opts.loc) { params.push(opts.loc); where.push('loc = $' + params.length); }
  if (opts.status) { params.push(opts.status); where.push('(' + STATE_SQL + ') = $' + params.length); }
  if (opts.q) { params.push('%' + opts.q.replace(/[\\%_]/g, '\\$&') + '%'); where.push('item_name ilike $' + params.length); }
  params.push(Math.min(1000, opts.limit || 500));
  return db.query(
    'select ' + COLUMNS + ' from app_labels ' + (where.length ? 'where ' + where.join(' and ') + ' ' : '') +
    'order by expires_at asc limit $' + params.length, params
  ).then(function (r) { return r.rows.map(toApi); });
}

/* { ACTIVE, EXPIRING, EXPIRED } per restaurant, live labels only. */
function counts(loc) {
  var params = [];
  var sql = 'select loc, ' + STATE_SQL + ' as state, count(*)::int as n from app_labels where discarded_at is null';
  if (loc) { params.push(loc); sql += ' and loc = $1'; }
  return db.query(sql + ' group by 1, 2', params).then(function (r) {
    var out = {};
    r.rows.forEach(function (row) {
      out[row.loc] = out[row.loc] || { ACTIVE: 0, EXPIRING: 0, EXPIRED: 0 };
      out[row.loc][row.state] = row.n;
    });
    return out;
  });
}

/* patch: any of { itemName, preparedAt, expiresAt, notes, photoId }. A new
   expiry time puts the label back to ACTIVE in the scheduler's eyes, so the
   next change from there is noticed and notified again. */
function update(id, patch, by, client) {
  var sets = [], params = [id];
  function set(col, v) { params.push(v); sets.push(col + ' = $' + params.length); }
  if (patch.itemName !== undefined) set('item_name', patch.itemName);
  if (patch.preparedAt !== undefined) set('prepared_at', new Date(patch.preparedAt));
  if (patch.expiresAt !== undefined) { set('expires_at', new Date(patch.expiresAt)); sets.push("expiry_state = 'ACTIVE'"); }
  if (patch.notes !== undefined) set('notes', patch.notes || null);
  if (patch.photoId !== undefined) set('photo_id', patch.photoId);
  set('updated_by_name', by);
  sets.push('updated_at = now()');
  return (client || db).query(
    'update app_labels set ' + sets.join(', ') + ' where id = $1 and discarded_at is null returning ' + COLUMNS, params
  ).then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

function discard(id, by) {
  return db.query(
    'update app_labels set discarded_at = now(), discarded_by_name = $2, updated_at = now() ' +
    'where id = $1 and discarded_at is null returning ' + COLUMNS, [id, by]
  ).then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

/* For the scheduler: every live label whose status has moved on since it
   was last looked at, updated in the same statement so two scheduler runs
   at once cannot both act on the same change. */
function advanceStates() {
  return db.query(
    'with moved as (select id, ' + STATE_SQL + ' as now_state from app_labels ' +
    '  where discarded_at is null and expiry_state <> (' + STATE_SQL + ') for update skip locked) ' +
    'update app_labels l set expiry_state = moved.now_state from moved where l.id = moved.id ' +
    "and (l.expiry_state = 'ACTIVE' or moved.now_state = 'EXPIRED') " +
    'returning l.id, l.loc, l.item_name, l.expires_at, l.expiry_state'
  ).then(function (r) { return r.rows; });
}

module.exports = {
  EXPIRING_SOON_HOURS: EXPIRING_SOON_HOURS,
  newId: newId,
  stateAt: stateAt,
  toApi: toApi,
  create: create,
  findRow: findRow,
  list: list,
  counts: counts,
  update: update,
  discard: discard,
  advanceStates: advanceStates
};
