'use strict';
/* ---------------------------------------------------------------------------
   Bookends Cleaning — long-running server (local and Render).

   The app itself is built in ./app.js. This file only adds what a process
   that stays up needs: a database check before accepting traffic, listen(),
   an hourly cleanup, and a clean shutdown. On Vercel none of this runs —
   api/index.js exports the app directly and the daily cron at
   /api/cron/cleanup does the cleanup instead.
   --------------------------------------------------------------------------- */

var config = require('./config/env');
var db = require('./db/pool');
var app = require('./app');
var cleanup = require('./services/cleanupService');
var scheduler = require('./services/scheduler');
var errorHandler = require('./middleware/errorHandler');

/* Confirm the database is reachable before accepting traffic, so a bad
   DATABASE_URL fails loudly at boot instead of as a 500 on someone's first
   login attempt. */
function start() {
  errorHandler.installProcessHandlers();

  return db.query('select 1')
  .then(function () {
    console.log('[boot] database connection OK');

    var server = app.listen(config.port, function () {
      console.log('[boot] Bookends compliance server listening on http://localhost:' + config.port + ' (' + config.env + ')');
      if (!config.isProd) console.log('[boot] open http://localhost:' + config.port + ' in a browser');
    });

    /* Expired sessions and rate-limit windows are already unusable; this just
       stops their tables growing forever. */
    var purge = setInterval(function () {
      cleanup.run()
        .then(function (n) { console.log('[cleanup] ' + JSON.stringify(n)); })
        .catch(function (err) { console.error('[cleanup] failed:', err.message); });
    }, 60 * 60 * 1000);
    if (purge.unref) purge.unref();

    /* Checklist reminders and label expiry, once a minute. */
    var ticker = setInterval(function () {
      scheduler.tick().catch(function (err) { console.error('[scheduler] ' + err.message); });
    }, 60 * 1000);
    if (ticker.unref) ticker.unref();
    setTimeout(function () { scheduler.kick(true); }, 3000);

    /* Finish in-flight requests and close the pool on a deploy restart. */
    ['SIGTERM', 'SIGINT'].forEach(function (sig) {
      process.on(sig, function () {
        console.log('[boot] ' + sig + ' received, shutting down');
        clearInterval(purge);
        clearInterval(ticker);
        server.close(function () {
          db.close().then(function () { process.exit(0); }, function () { process.exit(0); });
        });
        setTimeout(function () { process.exit(1); }, 10000).unref();
      });
    });

    return server;
  })
  .catch(function (err) {
    console.error('[boot] cannot reach the database — check DATABASE_URL and DATABASE_SSL in .env');
    console.error('[boot] ' + err.message);
    process.exit(1);
  });
}

/* Only bind a port when this file is the program being run. Requiring it
   (from a test, or to mount the app inside another server) gives you the
   configured Express app without a listener fighting for the port. */
if (require.main === module) start();

module.exports = app;
module.exports.start = start;
