'use strict';
/* ---------------------------------------------------------------------------
   The two roles the app is built around: Admin and User (Location Manager).

   The database still holds the finer roles it always had, so nothing that
   already works (the Flutter app, existing accounts) has to change. This file
   is the one place that folds them into the two:

     Admin  — every role that sees all 8 restaurants:
              superadmin, exec, aexec, admin, hok, auditor
     User   — manager and staff: one restaurant, their own (users.loc)

   The Auditor stays read-only. Every new route asks these functions, using
   the role and restaurant from the signed token — never from the request.
   --------------------------------------------------------------------------- */

var userModel = require('../models/userModel');

var ADMIN_ROLES = userModel.ALL_LOCATION_ROLES;           // see every restaurant
var READ_ONLY_ROLES = ['auditor'];
var USER_ROLES = ['manager', 'staff'];

function isAdmin(auth) { return !!auth && ADMIN_ROLES.indexOf(auth.role) > -1; }
function isReadOnly(auth) { return !!auth && READ_ONLY_ROLES.indexOf(auth.role) > -1; }
/* An admin who may change things: everyone on the admin side but the Auditor. */
function isAdminWriter(auth) { return isAdmin(auth) && !isReadOnly(auth); }
/* User management and Wipe All Data. */
function isManager(auth) { return !!auth && userModel.MANAGER_ROLES.indexOf(auth.role) > -1; }

/* Which restaurant's records this person may read.
   { all: true }            — an admin: every restaurant
   { all: false, loc: 'X' } — a location manager: their own
   { all: false, loc: null }— a user with no restaurant set: nothing */
function scope(auth) {
  if (isAdmin(auth)) return { all: true, loc: null };
  return { all: false, loc: (auth && auth.loc) || null };
}

/* May this person see a record that belongs to restaurant `loc`? */
function canSeeLoc(auth, loc) {
  var s = scope(auth);
  return s.all || (!!s.loc && s.loc === loc);
}

function forbid(res, message) {
  return res.status(403).json({ error: message || 'You do not have permission to do that', code: 'FORBIDDEN' });
}

/* Express guards. */
function requireAdmin(req, res, next) {
  if (!isAdmin(req.auth)) return forbid(res);
  next();
}
function requireAdminWriter(req, res, next) {
  if (!isAdminWriter(req.auth)) return forbid(res, isAdmin(req.auth) ? 'Your account is read-only.' : undefined);
  next();
}
function requireWriter(req, res, next) {
  if (isReadOnly(req.auth)) return forbid(res, 'Your account is read-only.');
  next();
}

module.exports = {
  ADMIN_ROLES: ADMIN_ROLES,
  USER_ROLES: USER_ROLES,
  isAdmin: isAdmin,
  isReadOnly: isReadOnly,
  isAdminWriter: isAdminWriter,
  isManager: isManager,
  scope: scope,
  canSeeLoc: canSeeLoc,
  forbid: forbid,
  requireAdmin: requireAdmin,
  requireAdminWriter: requireAdminWriter,
  requireWriter: requireWriter
};
