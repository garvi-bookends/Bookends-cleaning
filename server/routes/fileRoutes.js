'use strict';
/* ---------------------------------------------------------------------------
   /api/files — photos for cleaning tasks, checklists and labels.

     POST /api/files            the image itself (image/jpeg or image/png,
                                at most 2 MB) -> { id }. Signed-in, not
                                read-only. The id is then sent with the task,
                                checklist or label it belongs to.
     GET  /api/files/:id?e&s    the photo, through a signed link the server
                                handed out with a record (see photoStore).

   /api/photos (the older endpoint the Flutter app uses) is unchanged.
   --------------------------------------------------------------------------- */

var express = require('express');
var photos = require('../services/photoStore');
var access = require('../services/access');
var requireAuth = require('../middleware/requireAuth');
var rateLimit = require('../middleware/rateLimit');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

/* Plenty for a busy shift (a checklist with a photo per item, retakes and
   all), but a stop on one account filling the photo store. Per person, not
   per network: a whole kitchen shares one Wi-Fi address. */
var uploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  keyBy: function (req) { return 'photo:' + req.auth.id; },
  message: 'Too many photos in the last hour. Please wait a little and try again.'
});

router.post('/',
  requireAuth,
  access.requireWriter,
  uploadLimit,
  express.raw({ type: ['image/jpeg', 'image/png'], limit: photos.MAX_BYTES }),
  asyncHandler(function (req, res) {
    return photos.save(req.body, { userId: req.auth.id, loc: req.auth.loc || null }).then(function (id) {
      res.status(201).json({ id: id, url: photos.urlFor(id) });
    });
  })
);

router.get('/:id', asyncHandler(function (req, res) {
  var id = String(req.params.id || '');
  if (!/^PH-[A-F0-9]{18}$/.test(id) || !photos.checkLink(id, req.query.e, req.query.s)) {
    return res.status(404).json({ error: 'Photo not found', code: 'NOT_FOUND' });
  }
  return photos.load(id).then(function (p) {
    if (!p) return res.status(404).json({ error: 'Photo not found', code: 'NOT_FOUND' });
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('X-Content-Type-Options', 'nosniff');
    if (p.url) return res.redirect(302, p.url);
    res.type(p.mime).send(p.bytes);
  });
}));

module.exports = router;
