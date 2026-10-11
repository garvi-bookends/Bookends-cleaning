'use strict';
/* ---------------------------------------------------------------------------
   Bookends Cleaning — the Express app.

   This file builds the app and nothing else: no listen(), no timers. That is
   what lets the same code run two ways:

     - server/server.js   requires it and calls listen()  (local, Render)
     - api/index.js       exports it as a Vercel function (Vercel)

   On Vercel, index.html is served by the CDN from public/ and only /api/*
   reaches this app. Locally and on Render, this app serves index.html too.
   Same origin either way, which is why the refresh cookie can be
   SameSite=Strict and there is no CORS preflight on every API call.
   --------------------------------------------------------------------------- */

var path = require('path');
var express = require('express');
var helmet = require('helmet');
var cors = require('cors');
var compression = require('compression');
var cookieParser = require('cookie-parser');

var config = require('./config/env');
var db = require('./db/pool');
var errorHandler = require('./middleware/errorHandler');
var securityHeaders = require('./securityHeaders');

var app = express();

/* --------------------------------------------------------------------------
   Platform assumptions
   -------------------------------------------------------------------------- */

/* Vercel, Render and nginx all terminate TLS in front of the app. Without
   this, req.ip is the proxy's address (so rate limiting sees every user as
   one client) and `secure` cookies are never set. */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* --------------------------------------------------------------------------
   Security headers — the directives live in securityHeaders.js so that
   vercel.json can be checked against them.
   -------------------------------------------------------------------------- */

app.use(helmet({
  /* useDefaults: false — every directive is spelled out in securityHeaders.js
     rather than half-inherited from helmet. Helmet's defaults include
     upgrade-insecure-requests, which broke sign-in over plain http from any
     address but localhost; it is now added only in production (HTTPS). */
  contentSecurityPolicy: {
    useDefaults: false,
    directives: securityHeaders.cspDirectives({ upgrade: config.isProd })
  },
  /* The app embeds photos as data: and blob: URIs, which COEP blocks. */
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  frameguard: { action: 'deny' },
  hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false
}));

/* --------------------------------------------------------------------------
   CORS
   -------------------------------------------------------------------------- */

/* Empty CORS_ORIGINS means same-origin only, which is the recommended setup.
   When origins are listed, credentials are enabled so the refresh cookie can
   travel — which is exactly why the list is an allowlist and never '*'.
   Access-Control-Allow-Origin: * and credentials are mutually exclusive in
   every browser, and for good reason. */
if (config.corsOrigins.length) {
  app.use(cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);                 // curl, same-origin
      if (config.corsOrigins.indexOf(origin) > -1) return cb(null, true);
      cb(new Error('Origin ' + origin + ' is not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
}

/* --------------------------------------------------------------------------
   Parsers
   -------------------------------------------------------------------------- */

app.use(compression());
/* Sync batches can carry a photo taken offline as a data: URL inside a task,
   so /api/sync gets 1mb. It is mounted first; the 100kb parser below then
   sees an already-parsed body and leaves it alone. Everything else — auth
   JSON above all — stays at 100kb. Photos proper go to /api/photos as raw
   bytes and are parsed there. */
app.use('/api/sync', express.json({ limit: '1mb' }));
/* A daily checklist carries its photo: normally a Blob URL, but if the upload
   could not be made, the app's own compressed JPEG. */
app.use('/api/checklists', express.json({ limit: '600kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

/* Minimal request log. Passwords are in the body, which is never logged. */
app.use(function (req, res, next) {
  if (req.path.indexOf('/api/') !== 0) return next();
  var started = Date.now();
  res.on('finish', function () {
    console.log('[api] ' + req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + ' (' + (Date.now() - started) + 'ms)');
  });
  next();
});

/* One-time data fixes run before the first API request is answered. */
var oneTimeFixes = require('./db/oneTimeFixes');
app.use('/api', function (req, res, next) {
  oneTimeFixes.ready().then(function () { next(); });
});

/* Time-based reminders and expiry checks. A long-running server also runs
   these every minute (server.js); this keeps a serverless host on time too,
   as long as someone is using the app. It never delays the request. */
var scheduler = require('./services/scheduler');
app.use('/api', function (req, res, next) {
  if (req.path.indexOf('/cron/') !== 0) scheduler.kick();
  next();
});

/* --------------------------------------------------------------------------
   Routes
   -------------------------------------------------------------------------- */

app.get('/api/health', function (req, res) {
  db.query('select 1 as ok')
    .then(function () { res.json({ ok: true, env: config.env }); })
    .catch(function (err) {
      console.error('[health] database unreachable:', err.message);
      res.status(503).json({ ok: false, error: 'Database unreachable' });
    });
});

/* Non-secret settings the frontend needs at boot. Deliberately tiny: it
   exposes the starting password (which the UI already prints on screen for
   the admin) and the minimum length, and nothing else. No secrets, no
   connection strings, no keys (req 10). */
app.get('/api/config', function (req, res) {
  res.json({
    defaultPassword: config.password.defaultPassword,
    minPasswordLength: config.password.minLength
  });
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/sync', require('./routes/syncRoutes'));
app.use('/api/photos', require('./routes/photoRoutes'));
app.use('/api/cron', require('./routes/cronRoutes'));
app.use('/api/checklist', require('./routes/jobRoutes'));        // Job Management
app.use('/api/checklists', require('./routes/checklistRoutes'));  // Lunch / Dinner / Closing
app.use('/api/tasks', require('./routes/taskRoutes'));            // Cleaning Task
app.use('/api/labels', require('./routes/labelRoutes'));          // Labeling and Expiry
app.use('/api/files', require('./routes/fileRoutes'));            // task, checklist and label photos
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));   // Admin Dashboard
app.use('/api/audit', require('./routes/auditRoutes'));           // Admin Settings > Audit Log

/* An unmatched /api/* path returns JSON, not the SPA shell, so a typo in a
   fetch URL shows up as a 404 instead of index.html failing to parse. */
app.use('/api', errorHandler.notFound);

/* --------------------------------------------------------------------------
   Static frontend (local and Render — on Vercel the CDN serves it)
   -------------------------------------------------------------------------- */

var ROOT = path.join(__dirname, '..');
var INDEX = path.join(ROOT, 'index.html');

/* index.html is served with no-cache so a deployed change reaches installed
   PWAs on the next load instead of sitting in the HTTP cache. These routes
   come before express.static so the live index.html always wins over the
   copy `npm run build` leaves in public/ for Vercel. */
function sendApp(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(INDEX);
}

app.get('/', sendApp);
app.get('/index.html', sendApp);

/* Only ./public is served as a static directory.

   Pointing express.static at the project root would publish everything next
   to index.html — server/, package.json, node_modules, every backend source
   file. Nothing there contains a secret (those come from the environment),
   but the schema and the auth logic are not the public's business, and a
   file added to the repo later might well be. So the whitelist is: this
   folder, plus index.html by name. vercel.json applies the same rule on
   Vercel by publishing public/ and nothing else. */
app.use(express.static(path.join(ROOT, 'public'), {
  index: false,
  dotfiles: 'deny',
  setHeaders: function (res, filePath) {
    if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

/* Deep links like /#p=P-CPP-01 are handled client-side, so any other GET that
   is not an API call gets the app shell. Everything else is a 404 rather than
   an accidental file read. */
app.get('*', function (req, res, next) {
  if (req.path.indexOf('/api/') === 0) return next();
  sendApp(req, res);
});

/* --------------------------------------------------------------------------
   Errors — must be last
   -------------------------------------------------------------------------- */
app.use(errorHandler);

module.exports = app;
