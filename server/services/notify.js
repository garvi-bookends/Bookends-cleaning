'use strict';
/* ---------------------------------------------------------------------------
   Notifications — stored per person in app_notifications.

   Who receives what:
     toAdmins(...)        every active admin account (all 8 restaurants)
     toRestaurant(loc,..) every active location manager / staff at that
                          restaurant

   A notification can carry a dedupeKey. The unique index on
   (user_id, dedupe_key) makes a repeated send a no-op, which is what lets the
   scheduler run as often as it likes without anyone getting a reminder twice.

   Sending never throws: the action that caused it has already happened.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var access = require('./access');

/* n: { kind, title, body, loc, linkType, linkId, dedupeKey } */
function insertFor(userSql, userParams, n) {
  var base = userParams.length;
  var params = userParams.concat([n.kind, n.title, n.body || null, n.loc || null,
    n.linkType || null, n.linkId || null, n.dedupeKey || null]);
  var p = function (i) { return '$' + (base + i); };
  return db.query(
    'insert into app_notifications (user_id, kind, title, body, loc, link_type, link_id, dedupe_key) ' +
    'select u.id, ' + [p(1), p(2), p(3), p(4), p(5), p(6), p(7)].join(', ') + ' from app_users u where ' + userSql +
    ' and u.disabled = false and u.pending = false ' +
    'on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing',
    params
  ).then(function (r) { return r.rowCount; }).catch(function (err) {
    console.error('[notify] could not send "' + n.kind + '":', err.message);
    return 0;
  });
}

function toAdmins(n) {
  return insertFor('u.role = any($1)', [access.ADMIN_ROLES], n);
}

function toRestaurant(loc, n) {
  if (!loc) return Promise.resolve(0);
  return insertFor('u.role = any($1) and u.loc = $2', [access.USER_ROLES, loc], n);
}

/* --------------------------------------------------------------------------
   Reading — always one person's own
   -------------------------------------------------------------------------- */

function list(userId, limit) {
  return Promise.all([
    db.query(
      'select id, kind, title, body, loc, link_type, link_id, created_at, read_at from app_notifications ' +
      'where user_id = $1 order by created_at desc, id desc limit $2', [userId, limit || 50]),
    unreadCount(userId)
  ]).then(function (got) {
    return {
      unread: got[1],
      items: got[0].rows.map(function (r) {
        return {
          id: Number(r.id), kind: r.kind, title: r.title, body: r.body, loc: r.loc,
          linkType: r.link_type, linkId: r.link_id,
          createdAt: new Date(r.created_at).getTime(),
          read: !!r.read_at
        };
      })
    };
  });
}

function unreadCount(userId) {
  return db.query('select count(*)::int as n from app_notifications where user_id = $1 and read_at is null', [userId])
    .then(function (r) { return r.rows[0].n; });
}

function markRead(userId, id) {
  return db.query('update app_notifications set read_at = now() where user_id = $1 and id = $2 and read_at is null', [userId, id])
    .then(function (r) { return r.rowCount; });
}

function markAllRead(userId) {
  return db.query('update app_notifications set read_at = now() where user_id = $1 and read_at is null', [userId])
    .then(function (r) { return r.rowCount; });
}

/* Housekeeping: read notifications older than 60 days go. */
function purgeOld() {
  return db.query("delete from app_notifications where read_at is not null and created_at < now() - interval '60 days'")
    .then(function (r) { return r.rowCount; });
}

module.exports = {
  toAdmins: toAdmins,
  toRestaurant: toRestaurant,
  list: list,
  unreadCount: unreadCount,
  markRead: markRead,
  markAllRead: markAllRead,
  purgeOld: purgeOld
};
