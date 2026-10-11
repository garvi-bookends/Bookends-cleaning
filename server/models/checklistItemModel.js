'use strict';
/* ---------------------------------------------------------------------------
   Checklist items (app_checklist_items) — what Lunch, Dinner and Closing ask.

   Admins add, edit and remove items. "Remove" sets active = false rather than
   deleting, so nothing a past submission refers to ever disappears; each
   submission also keeps its own copy of the wording.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');

var TYPES = ['LUNCH', 'DINNER', 'CLOSING'];
var COLUMNS = 'id, checklist_type, text, required, photo_required, sort, active, updated_at';

function newId() { return 'CI-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

function toApi(row) {
  return {
    id: row.id,
    type: row.checklist_type,
    text: row.text,
    required: row.required,
    photoRequired: row.photo_required,
    sort: row.sort,
    active: row.active
  };
}

/* Active items, in order. type null = all three. */
function listActive(type) {
  var params = [], sql = 'select ' + COLUMNS + ' from app_checklist_items where active = true';
  if (type) { params.push(type); sql += ' and checklist_type = $1'; }
  return db.query(sql + ' order by checklist_type, sort, created_at', params).then(function (r) { return r.rows.map(toApi); });
}

function findById(id) {
  return db.query('select ' + COLUMNS + ' from app_checklist_items where id = $1', [id])
    .then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

/* New items go to the end of their checklist. */
function create(it, by) {
  return db.query(
    'insert into app_checklist_items (id, checklist_type, text, required, photo_required, sort, created_by, updated_by) ' +
    'values ($1, $2, $3, $4, $5, (select coalesce(max(sort), 0) + 10 from app_checklist_items where checklist_type = $2), $6, $6) ' +
    'returning ' + COLUMNS,
    [newId(), it.type, it.text, it.required !== false, !!it.photoRequired, by]
  ).then(function (r) { return toApi(r.rows[0]); });
}

function update(id, patch, by) {
  var sets = [], params = [id];
  function set(col, v) { params.push(v); sets.push(col + ' = $' + params.length); }
  if (patch.text !== undefined) set('text', patch.text);
  if (patch.required !== undefined) set('required', patch.required);
  if (patch.photoRequired !== undefined) set('photo_required', patch.photoRequired);
  if (patch.sort !== undefined) set('sort', patch.sort);
  set('updated_by', by);
  sets.push('updated_at = now()');
  return db.query('update app_checklist_items set ' + sets.join(', ') + ' where id = $1 and active = true returning ' + COLUMNS, params)
    .then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

function remove(id, by) {
  return db.query(
    'update app_checklist_items set active = false, updated_by = $2, updated_at = now() where id = $1 and active = true returning ' + COLUMNS,
    [id, by]
  ).then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

/* Swaps an item with its neighbour above or below. */
function move(id, dir, by) {
  return db.transaction(function (client) {
    return client.query('select id, checklist_type, sort from app_checklist_items where id = $1 and active = true', [id]).then(function (r) {
      var it = r.rows[0];
      if (!it) return null;
      return client.query(
        'select id, sort from app_checklist_items where checklist_type = $1 and active = true and id <> $2 and ' +
        (dir < 0 ? 'sort <= $3 order by sort desc' : 'sort >= $3 order by sort asc') + ', created_at limit 1',
        [it.checklist_type, it.id, it.sort]
      ).then(function (n) {
        var other = n.rows[0];
        if (!other) return true;
        var a = it.sort, b = other.sort === it.sort ? it.sort + dir : other.sort;
        return client.query('update app_checklist_items set sort = $2, updated_by = $3, updated_at = now() where id = $1', [it.id, b, by])
          .then(function () { return client.query('update app_checklist_items set sort = $2, updated_at = now() where id = $1', [other.id, a]); })
          .then(function () { return true; });
      });
    });
  });
}

module.exports = { TYPES: TYPES, listActive: listActive, findById: findById, create: create, update: update, remove: remove, move: move };
