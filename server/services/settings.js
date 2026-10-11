'use strict';
/* ---------------------------------------------------------------------------
   app_settings — small values the server keeps for itself.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');

function get(key, fallback) {
  return db.query('select value from app_settings where key = $1', [key])
    .then(function (r) { return r.rows[0] ? r.rows[0].value : fallback; });
}

function set(key, value, client) {
  return (client || db).query(
    'insert into app_settings (key, value, updated_at) values ($1, $2, now()) ' +
    'on conflict (key) do update set value = excluded.value, updated_at = now()', [key, String(value)]);
}

module.exports = { get: get, set: set };
