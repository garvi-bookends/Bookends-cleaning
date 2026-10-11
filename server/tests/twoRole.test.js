'use strict';
/* ---------------------------------------------------------------------------
   The rules behind the two-role update that need no database: reading IST
   times typed into forms, label expiry status, who sees which restaurant,
   and signed photo links.
   --------------------------------------------------------------------------- */

var test = require('node:test');
var assert = require('node:assert');

/* config/env.js insists on these; the tests never connect to anything. */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test@localhost/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'y'.repeat(48);

var ist = require('../services/ist');
var access = require('../services/access');
var labels = require('../models/labelModel');
var photos = require('../services/photoStore');

test('IST form times are read as India time, whatever the server zone', function () {
  /* 10 Oct 2026 14:30 IST is 09:00 UTC. */
  assert.strictEqual(ist.parseLocal('2026-10-10T14:30'), Date.UTC(2026, 9, 10, 9, 0));
  /* Just after midnight IST is the previous day in UTC. */
  assert.strictEqual(ist.parseLocal('2026-10-11T00:15'), Date.UTC(2026, 9, 10, 18, 45));
});

test('impossible or malformed times are refused', function () {
  ['', '2026-02-31T10:00', '2026-13-01T10:00', '2026-10-10T24:00', '2026-10-10 10:00', 'tomorrow'].forEach(function (s) {
    assert.strictEqual(ist.parseLocal(s), null, s);
  });
});

test('label status: active, expiring within 24 hours, expired', function () {
  var now = Date.UTC(2026, 9, 10, 9, 0);
  var H = 3600000;
  assert.strictEqual(labels.stateAt(now + 48 * H, now), 'ACTIVE');
  assert.strictEqual(labels.stateAt(now + 24 * H + 1, now), 'ACTIVE');
  assert.strictEqual(labels.stateAt(now + 24 * H, now), 'EXPIRING');
  assert.strictEqual(labels.stateAt(now + 1, now), 'EXPIRING');
  assert.strictEqual(labels.stateAt(now, now), 'EXPIRED');
  assert.strictEqual(labels.stateAt(now - H, now), 'EXPIRED');
});

test('two roles: admins see every restaurant, a location manager only theirs', function () {
  ['superadmin', 'exec', 'aexec', 'admin', 'hok', 'auditor'].forEach(function (role) {
    assert.ok(access.isAdmin({ role: role }), role);
    assert.ok(access.canSeeLoc({ role: role, loc: null }, 'AHM-AIKO'), role);
  });
  var lm = { role: 'manager', loc: 'SUR-PREP' };
  assert.ok(!access.isAdmin(lm));
  assert.ok(access.canSeeLoc(lm, 'SUR-PREP'));
  assert.ok(!access.canSeeLoc(lm, 'AHM-AIKO'));
  /* A user with no restaurant sees nothing at all. */
  assert.ok(!access.canSeeLoc({ role: 'staff', loc: null }, 'SUR-PREP'));
  assert.ok(!access.canSeeLoc({ role: 'staff', loc: null }, null));
});

test('the Auditor is an admin who cannot change anything', function () {
  assert.ok(access.isAdmin({ role: 'auditor' }));
  assert.ok(!access.isAdminWriter({ role: 'auditor' }));
  assert.ok(!access.isManager({ role: 'auditor' }));
  assert.ok(access.isManager({ role: 'admin' }));
  assert.ok(!access.isManager({ role: 'hok' }));
});

test('photo links: valid until they expire, useless once altered', function () {
  var id = 'PH-0123456789ABCDEF01';
  var url = photos.urlFor(id);
  var q = new URLSearchParams(url.split('?')[1]);
  assert.ok(photos.checkLink(id, q.get('e'), q.get('s')));
  assert.ok(!photos.checkLink('PH-0123456789ABCDEF02', q.get('e'), q.get('s')), 'another photo');
  assert.ok(!photos.checkLink(id, String(+q.get('e') + 3600), q.get('s')), 'longer expiry');
  var sig = q.get('s');
  var altered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.ok(!photos.checkLink(id, q.get('e'), altered), 'altered signature');
  assert.ok(!photos.checkLink(id, '1000', q.get('s')), 'expired');
});

test('only real JPEG and PNG files count as photos', function () {
  assert.deepStrictEqual(photos.imageType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0])).mime, 'image/jpeg');
  assert.deepStrictEqual(photos.imageType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0])).mime, 'image/png');
  assert.strictEqual(photos.imageType(Buffer.from('<svg onload=alert(1)>')), null);
  assert.strictEqual(photos.imageType(Buffer.from('GIF89a......')), null);
});
