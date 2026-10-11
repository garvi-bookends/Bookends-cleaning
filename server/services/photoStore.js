'use strict';
/* ---------------------------------------------------------------------------
   Photos for cleaning tasks, checklists and labels.

   Storing
     The file's own first bytes decide whether it is a JPEG or PNG — never the
     Content-Type the client claims. With a Vercel Blob store configured the
     bytes go there under a random name; otherwise they go into app_photos in
     Postgres. Either way app_photos holds one row per photo, and that row is
     what the records point at.

   Attaching
     A photo is uploaded first and attached when the record is saved. attach()
     only accepts a photo the same person uploaded that is not already part of
     another record, so nobody can borrow someone else's photo by its id.

   Handing out
     A photo is only reachable through a signed link that expires (urlFor).
     Links are made when a record is sent to someone already allowed to see
     it, so the link carries that permission and nothing else. The signature
     uses a key derived from JWT_SECRET; the expiry is rounded to the hour so
     the same photo keeps the same link (and the browser's cache) for a while.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');
var config = require('../config/env');

var MAX_BYTES = 2 * 1024 * 1024;
var LINK_HOURS = 6;
var KEY = crypto.createHash('sha256').update('bookends-photo-links:' + config.jwt.secret).digest();

function newId() { return 'PH-' + crypto.randomBytes(9).toString('hex').toUpperCase(); }

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  return null;
}

function badPhoto(message, status) {
  var err = new Error(message);
  err.status = status || 400; err.code = 'BAD_PHOTO'; err.expected = true;
  return err;
}

/* Stores one photo. Resolves to its id. */
function save(buf, opts) {
  if (!Buffer.isBuffer(buf) || !buf.length) return Promise.reject(badPhoto('Choose a photo to upload.'));
  if (buf.length > MAX_BYTES) return Promise.reject(badPhoto('That photo is too large. Please take it again.', 413));
  var type = imageType(buf);
  if (!type) return Promise.reject(badPhoto('That file is not a photo. Please use a JPEG or PNG picture.', 415));

  var id = newId();
  var stored = config.blobToken
    ? require('@vercel/blob').put('photos/' + (opts.loc || 'admin') + '/' + id.toLowerCase() + '.' + type.ext, buf, {
        access: 'public', contentType: type.mime, addRandomSuffix: true, token: config.blobToken
      }).then(function (b) { return { url: b.url, bytes: null }; })
    : Promise.resolve({ url: null, bytes: buf });

  return stored.then(function (s) {
    return db.query(
      'insert into app_photos (id, loc, mime, size, bytes, url, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, opts.loc || null, type.mime, buf.length, s.bytes, s.url, opts.userId]
    );
  }).then(function () { return id; });
}

/* Marks a photo as part of a record. Resolves true, or false when the photo
   does not exist, was uploaded by someone else, or already belongs to
   another record. */
function attach(photoId, userId, ref, client) {
  if (!photoId) return Promise.resolve(false);
  if (!/^PH-[A-F0-9]{18}$/.test(String(photoId))) return Promise.resolve(false);
  return (client || db).query(
    'update app_photos set attached_to = $3 where id = $1 and uploaded_by = $2 and attached_to is null',
    [photoId, userId, ref]
  ).then(function (r) { return r.rowCount === 1; });
}

function sign(id, exp) {
  return crypto.createHmac('sha256', KEY).update(id + '.' + exp).digest('base64url').slice(0, 32);
}

/* A link to the photo, for someone already allowed to see it. */
function urlFor(id) {
  if (!id) return null;
  var hour = 3600;
  var exp = (Math.floor(Date.now() / 1000 / hour) + LINK_HOURS) * hour;
  return '/api/files/' + encodeURIComponent(id) + '?e=' + exp + '&s=' + sign(id, exp);
}

function checkLink(id, e, s) {
  var exp = parseInt(e, 10);
  if (!exp || exp * 1000 < Date.now() || typeof s !== 'string') return false;
  var want = Buffer.from(sign(id, exp));
  var got = Buffer.from(s);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function load(id) {
  return db.query('select id, mime, bytes, url from app_photos where id = $1', [id]).then(function (r) { return r.rows[0] || null; });
}

/* Unattached uploads older than a day were abandoned forms. */
function purgeAbandoned() {
  return db.query("delete from app_photos where attached_to is null and created_at < now() - interval '1 day' returning url")
    .then(function (r) {
      var urls = r.rows.map(function (x) { return x.url; }).filter(Boolean);
      return deleteBlobs(urls).then(function () { return r.rowCount; });
    });
}

function deleteBlobs(urls) {
  if (!urls.length || !config.blobToken) return Promise.resolve();
  try {
    return require('@vercel/blob').del(urls, { token: config.blobToken }).catch(function (err) {
      console.error('[photos] could not delete stored files:', err.message);
    });
  } catch (e) { return Promise.resolve(); }
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  save: save,
  attach: attach,
  urlFor: urlFor,
  checkLink: checkLink,
  load: load,
  purgeAbandoned: purgeAbandoned,
  deleteBlobs: deleteBlobs,
  imageType: imageType
};
