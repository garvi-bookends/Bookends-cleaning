'use strict';
/* ---------------------------------------------------------------------------
   Moves every photo still held as bytes in app_photos into the Vercel Blob
   store, then keeps only its Blob link in the row.

     npm run photos-to-blob

   Needs in .env:
     DATABASE_URL            the database whose photos to move
     BLOB_READ_WRITE_TOKEN   the Blob store (Vercel → Storage → your Blob store
                             → .env.local tab)

   Safe to run again: a photo that already has a link is left alone, and the
   bytes are cleared only after the upload has succeeded.
   --------------------------------------------------------------------------- */

var path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
var pg = require('pg');
var connectionParams = require('../db/connectionParams');

var URL_ = process.env.DATABASE_URL || '';
var TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

function main() {
  if (!URL_ || !TOKEN) {
    console.error('\nSet DATABASE_URL and BLOB_READ_WRITE_TOKEN in .env first.\n');
    process.exit(1);
  }
  var put = require('@vercel/blob').put;
  var local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
  var c = new pg.Client(Object.assign(connectionParams(URL_), { ssl: local ? false : { rejectUnauthorized: false } }));
  var moved = 0, failed = 0;

  return c.connect().then(function () {
    return c.query('select id, loc, mime from app_photos where bytes is not null and url is null order by created_at');
  }).then(function (r) {
    console.log('\n[photos] ' + r.rows.length + ' photo(s) to move');
    return r.rows.reduce(function (p, row) {
      return p.then(function () {
        return c.query('select bytes from app_photos where id = $1', [row.id]).then(function (b) {
          var ext = row.mime === 'image/png' ? 'png' : 'jpg';
          return put('photos/' + (row.loc || 'admin') + '/' + row.id.toLowerCase() + '.' + ext, b.rows[0].bytes, {
            access: 'public', contentType: row.mime, addRandomSuffix: true, token: TOKEN
          });
        }).then(function (blob) {
          return c.query('update app_photos set url = $2, bytes = null where id = $1', [row.id, blob.url]);
        }).then(function () {
          moved++; console.log('  ✓ ' + row.id);
        }, function (err) {
          failed++; console.error('  ✗ ' + row.id + ': ' + err.message);
        });
      });
    }, Promise.resolve());
  }).then(function () {
    console.log('\n[photos] moved ' + moved + (failed ? ', failed ' + failed : '') + '\n');
    return c.end();
  }).then(function () {
    if (failed) process.exit(1);
  }).catch(function (err) {
    console.error('\n[photos] failed: ' + err.message + '\n');
    c.end().catch(function () {}).then(function () { process.exit(1); });
  });
}

main();
