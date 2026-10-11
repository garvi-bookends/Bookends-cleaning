'use strict';
/* ---------------------------------------------------------------------------
   /api/admin — user administration (reqs 1, 2, 6).

   Every route here is behind requireAuth + requireManager: the admins who
   manage accounts (Super Admin, Execution Head, Assistant Execution Head,
   Admin). Approving a self sign-up and answering a "forgot password" request
   stay with the Super Admin alone. Every change to an account is written to
   the audit log.

   Endpoints:
     GET    /api/admin/users                    list accounts with login info
     POST   /api/admin/users                    create a user (req 1)
     GET    /api/admin/users/suggest-uid        propose a free login ID
     PATCH  /api/admin/users/:id                change name / role / location
     POST   /api/admin/users/:id/reset-password reset a forgotten password
     DELETE /api/admin/users/:id                remove someone who has left
     GET    /api/admin/login-audit              recent sign-in attempts
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var userModel = require('../models/userModel');
var authService = require('../services/authService');
var passwords = require('../services/passwordService');
var config = require('../config/env');
var requireAuth = require('../middleware/requireAuth');
var requireSuperadmin = require('../middleware/requireRole').requireSuperadmin;
var requireManager = require('../middleware/requireRole').requireManager;
var audit = require('../services/audit');
var photos = require('../services/photoStore');
var settings = require('../services/settings');
var windows = require('../services/checklistWindows');
var validate = require('../middleware/validate');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;
var jobs = require('../models/jobModel');

/* Only job types that exist are stored against a person. */
function knownJobTypes(ids) {
  if (!ids) return Promise.resolve(ids);
  return jobs.existingTypeIds(ids).then(function (ok) { return ids.filter(function (id) { return ok.indexOf(id) > -1; }); });
}

var router = express.Router();

/* The Super Admin can only be changed by the Super Admin. Without this an
   Execution Head could reset the Super Admin's password and sign in as them, which
   would make "only the Super Admin approves sign-ups" meaningless. */
function protectsSuperadmin(req, res, target) {
  if (target.role === userModel.SUPERADMIN && req.auth.role !== userModel.SUPERADMIN) {
    res.status(403).json({ error: 'Only the Super Admin can change the Super Admin account', code: 'SUPERADMIN_PROTECTED' });
    return true;
  }
  return false;
}

/* Everything below this line needs a signed-in admin who manages accounts. */
router.use(requireAuth, requireManager, audit.withActor);

var ROLE_NAME = function (role) { return userModel.ALL_LOCATION_ROLES.indexOf(role) > -1 ? 'Admin' : 'Location Manager'; };
function userAudit(req, action, user, summary) {
  return audit.record(audit.actorOf(req), action, {
    loc: user.loc || null, entityType: 'user', entityId: user.id, ip: req.ip, summary: summary
  });
}

/* The admin view of an account. It includes the login bookkeeping from req 6
   — first-login status, last login, creation date — and still no hash. */
function adminUser(user) {
  return {
    id: user.id,
    uid: user.uid,
    name: user.name,
    role: user.role,
    loc: user.loc,
    mustChange: user.mustChange,
    firstLogin: user.firstLogin,
    lastLogin: user.lastLogin,
    loginCount: user.loginCount,
    disabled: user.disabled,
    pending: user.pending,
    resetRequestedAt: user.resetRequestedAt,
    email: user.email || '',
    jobTypes: user.jobTypes || [],
    createdAt: user.createdAt,
    _u: user._u
  };
}

/* ---------------------------------------------------------------------------
   GET /api/admin/users
   --------------------------------------------------------------------------- */
router.get('/users', asyncHandler(function (req, res) {
  return userModel.listUsers().then(function (users) {
    res.json({ users: users.map(adminUser) });
  });
}));

/* ---------------------------------------------------------------------------
   GET /api/admin/users/suggest-uid?name=Suresh

   Lets the create-user form keep auto-filling the login ID as the admin
   types, the way it did before, but with the uniqueness check done against
   the database rather than a local array.
   --------------------------------------------------------------------------- */
router.get('/users/suggest-uid', asyncHandler(function (req, res) {
  var name = String(req.query.name || '').trim();
  if (!name) return res.json({ uid: '' });

  return userModel.listUids().then(function (taken) {
    res.json({ uid: userModel.suggestUid(name, taken) });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/admin/users          — EXAMPLE ADMIN USER-CREATION API (req 1)

   Body: { name, role, loc?, uid?, password? }

   - uid omitted      -> derived from the first name, deduplicated
   - password omitted -> DEFAULT_PASSWORD from the environment
   - the password is hashed with bcrypt before the row is written; the
     plaintext exists only for the length of this request (req 3)
   - the plaintext is returned ONCE so the admin can hand it over, then it is
     unrecoverable
   --------------------------------------------------------------------------- */
router.post('/users', validate.validateCreateUser, asyncHandler(function (req, res) {
  var input = req.valid;
  var plainPassword = input.password || config.password.defaultPassword;

  /* Reject a weak initial password here rather than letting the user hit the
     wall on their first sign-in. The shared default is exempt: it is meant to
     be trivial and is force-changed on first login. */
  if (input.password) {
    var weak = passwords.validationError(input.password);
    if (weak) return res.status(400).json({ error: weak, code: 'WEAK_PASSWORD' });
  }

  return Promise.resolve()
    .then(function () {
      if (input.uid) return input.uid;
      return userModel.listUids().then(function (taken) {
        return userModel.suggestUid(input.name, taken);
      });
    })
    .then(function (uid) {
      return userModel.uidExists(uid).then(function (exists) {
        if (exists) {
          var err = new Error('The ID "' + uid + '" is already taken — choose another.');
          err.status = 409; err.code = 'UID_TAKEN'; err.expected = true;
          throw err;
        }
        return Promise.all([passwords.hash(plainPassword), knownJobTypes(input.jobTypes)]).then(function (got) {
          var passwordHash = got[0];
          return userModel.createUser({
            name: input.name,
            uid: uid,
            role: input.role,
            loc: input.loc,
            email: input.email,
            jobTypes: got[1],
            disabled: input.disabled,
            passwordHash: passwordHash,
            mustChange: true,          // forced to choose their own on first sign-in
            createdBy: req.auth.id
          });
        });
      });
    })
    .then(function (user) {
      console.log('[admin] ' + req.auth.uid + ' created user ' + user.uid + ' (' + user.role + ')');
      userAudit(req, 'user.create', user, 'Created account ' + user.name + ' (' + user.uid + ') as ' + ROLE_NAME(user.role));
      res.status(201).json({
        user: adminUser(user),
        /* Shown once in the "User created" panel. Not stored anywhere in this
           form and not retrievable afterwards. */
        initialPassword: plainPassword
      });
    });
}));

/* ---------------------------------------------------------------------------
   POST /api/admin/users/:id/approve

   Body: { role, loc? }

   Lets a self sign-up in. This is where the person's real role and kitchen
   are decided — they chose their own username and password, but not their
   access. Rejecting a sign-up is just DELETE /api/admin/users/:id.
   --------------------------------------------------------------------------- */
router.post('/users/:id/approve', requireSuperadmin, validate.validateUserIdParam, validate.validateApprove, asyncHandler(function (req, res) {
  var targetId = req.params.id;

  return userModel.findById(targetId).then(function (target) {
    if (!target) return res.status(404).json({ error: 'That sign-up no longer exists', code: 'NOT_FOUND' });
    if (!target.pending) return res.status(409).json({ error: target.name + ' is already approved', code: 'NOT_PENDING' });

    var needsLoc = userModel.ALL_LOCATION_ROLES.indexOf(req.valid.role) === -1;
    var loc = needsLoc ? (req.valid.loc || target.loc) : null;
    if (needsLoc && !loc) {
      return res.status(400).json({ error: 'Choose which kitchen they work in', code: 'LOCATION_REQUIRED' });
    }

    return userModel.approveUser(targetId, req.valid.role, loc).then(function (user) {
      console.log('[admin] ' + req.auth.uid + ' approved ' + user.uid + ' as ' + user.role + (user.loc ? ' @ ' + user.loc : ''));
      userAudit(req, 'user.approve', user, 'Approved the sign-up of ' + user.name + ' (' + user.uid + ') as ' + ROLE_NAME(user.role));
      res.json({ user: adminUser(user) });
    });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/admin/users/:id/dismiss-reset

   The Super Admin decides a "forgot password" request needs no action (a
   mistake, or it was sorted out another way). Answering it with a new
   password goes through /reset-password, which clears the request itself.
   --------------------------------------------------------------------------- */
router.post('/users/:id/dismiss-reset', requireSuperadmin, validate.validateUserIdParam, asyncHandler(function (req, res) {
  return userModel.dismissPasswordReset(req.params.id).then(function (changed) {
    if (!changed) return res.status(404).json({ error: 'There is no open reset request for that account', code: 'NOT_FOUND' });
    console.log('[admin] ' + req.auth.uid + ' dismissed a reset request for ' + req.params.id);
    res.json({ ok: true });
  });
}));

/* ---------------------------------------------------------------------------
   PATCH /api/admin/users/:id
   --------------------------------------------------------------------------- */
router.patch('/users/:id', validate.validateUserIdParam, validate.validateUpdateUser, asyncHandler(function (req, res) {
  var targetId = req.params.id;
  var patch = req.valid;

  return userModel.findById(targetId).then(function (target) {
    if (!target) return res.status(404).json({ error: 'That user no longer exists', code: 'NOT_FOUND' });
    if (protectsSuperadmin(req, res, target)) return;

    /* The Super Admin role is moved only with `npm run set-superadmin`, so the
       app can never end up with none — nobody would be left to approve. */
    if (target.role === userModel.SUPERADMIN && patch.role !== undefined) {
      return res.status(400).json({ error: 'The Super Admin role can only be moved on the server (npm run set-superadmin)', code: 'SUPERADMIN_FIXED' });
    }

    /* Guard against an admin demoting or disabling themselves out of user
       management, or removing the last manager, which would lock everyone out
       with no way back in short of direct database access. */
    var losesManagement =
      (patch.role !== undefined && userModel.MANAGER_ROLES.indexOf(patch.role) === -1) ||
      patch.disabled === true;

    if (losesManagement && userModel.MANAGER_ROLES.indexOf(target.role) > -1) {
      if (target.id === req.auth.id) {
        return res.status(400).json({
          error: 'You cannot remove your own admin access. Ask another Execution Head to do it.',
          code: 'SELF_DEMOTION'
        });
      }
      return userModel.countManagers().then(function (n) {
        if (n <= 1) {
          return res.status(400).json({
            error: 'This is the last account that can manage users. Promote someone else first.',
            code: 'LAST_MANAGER'
          });
        }
        return applyPatch();
      });
    }
    return applyPatch();

    function applyPatch() {
      return knownJobTypes(patch.jobTypes).then(function (jt) {
        if (jt !== undefined) patch.jobTypes = jt;
        return userModel.updateProfile(targetId, patch);
      }).then(function (user) {
        console.log('[admin] ' + req.auth.uid + ' updated user ' + user.uid + ': ' + JSON.stringify(patch));
        userAudit(req, 'user.update', user, 'Updated account ' + user.name + ' (' + user.uid + ')' +
          (patch.disabled === true ? ' — disabled' : patch.disabled === false ? ' — enabled' : ''));
        res.json({ user: adminUser(user) });
      });
    }
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/admin/users/:id/reset-password

   Body: { password? }  — omitted means back to DEFAULT_PASSWORD.

   Writes a NEW bcrypt hash over the old one and forces a change on next
   sign-in. Every existing session for that user is revoked, so a device
   someone left signed in cannot outlive the reset.
   --------------------------------------------------------------------------- */
router.post('/users/:id/reset-password', validate.validateUserIdParam, validate.validateResetPassword, asyncHandler(function (req, res) {
  var targetId = req.params.id;

  if (req.valid.password) {
    var weak = passwords.validationError(req.valid.password);
    if (weak) return res.status(400).json({ error: weak, code: 'WEAK_PASSWORD' });
  }

  return userModel.findById(targetId).then(function (target) {
    if (!target) return res.status(404).json({ error: 'That user no longer exists', code: 'NOT_FOUND' });
    if (protectsSuperadmin(req, res, target)) return;

    return authService.resetPassword(targetId, req.valid.password).then(function (result) {
      console.log('[admin] ' + req.auth.uid + ' reset the password for ' + result.user.uid);
      userAudit(req, 'user.reset_password', result.user, 'Set a new password for ' + result.user.name + ' (' + result.user.uid + ')');
      res.json({
        user: adminUser(result.user),
        password: result.password        // displayed once so the admin can pass it on
      });
    });
  });
}));

/* ---------------------------------------------------------------------------
   DELETE /api/admin/users/:id
   --------------------------------------------------------------------------- */
router.delete('/users/:id', validate.validateUserIdParam, asyncHandler(function (req, res) {
  var targetId = req.params.id;

  if (targetId === req.auth.id) {
    return res.status(400).json({ error: 'You cannot delete your own account', code: 'SELF_DELETE' });
  }

  return userModel.findById(targetId).then(function (target) {
    if (!target) return res.status(404).json({ error: 'That user no longer exists', code: 'NOT_FOUND' });
    if (protectsSuperadmin(req, res, target)) return;

    /* Rejecting a self sign-up is the Super Admin's decision, the same as
       approving one. Other admins can still remove ordinary accounts. */
    if (target.pending && req.auth.role !== userModel.SUPERADMIN) {
      return res.status(403).json({ error: 'Only the Super Admin can approve or reject new sign-ups', code: 'SUPERADMIN_ONLY' });
    }

    return Promise.resolve()
      .then(function () {
        if (userModel.MANAGER_ROLES.indexOf(target.role) === -1) return null;
        return userModel.countManagers().then(function (n) {
          if (n <= 1) {
            var err = new Error('This is the last account that can manage users. Promote someone else first.');
            err.status = 400; err.code = 'LAST_MANAGER'; err.expected = true;
            throw err;
          }
        });
      })
      .then(function () { return userModel.deleteUser(targetId); })
      .then(function () {
        console.log('[admin] ' + req.auth.uid + ' deleted user ' + target.uid);
        userAudit(req, 'user.delete', target, 'Removed account ' + target.name + ' (' + target.uid + ')');
        res.json({ ok: true, id: targetId });
      });
  });
}));

/* ---------------------------------------------------------------------------
   GET /api/admin/login-audit?limit=100

   The sign-in trail from req 6, useful for spotting a staff member who cannot
   get in or an account being guessed at.
   --------------------------------------------------------------------------- */
router.get('/login-audit', asyncHandler(function (req, res) {
  var limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  return db.query(
    'select at, uid, user_id, success, reason, ip from app_login_audit order by at desc limit $1',
    [limit]
  ).then(function (r) {
    res.json({
      entries: r.rows.map(function (row) {
        return {
          at: new Date(row.at).getTime(),
          uid: row.uid,
          userId: row.user_id,
          success: row.success,
          reason: row.reason,
          ip: row.ip
        };
      })
    });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/admin/wipe   { confirm: 'WIPE ALL DATA', password }

   Admins who manage accounts only (requireManager above), and only with the
   phrase typed out AND their own password, checked here against its hash.
   The UI's warnings stop an accidental tap; these checks are what decide.

   Deletes the operational RECORDS, all in one transaction:
     cleaning tasks, checklist submissions, labels, notifications, photos,
     and the older synced cleaning jobs and products.
   Keeps everything that was SET UP:
     accounts and passwords, checklist items, job types and services.
   Keeps the AUDIT LOG: app_admin_audit is never touched by a wipe, and the
   wipe itself is added to it. There is no endpoint that deletes audit
   history; that would need a separate, explicitly authorised process.

   The sync epoch (the time of this audit row) changes in the same
   transaction, so older devices drop their copy instead of uploading the
   deleted records back. Stored photo files are removed after the commit; a
   failure there is reported in the count, never as a failed wipe.
   --------------------------------------------------------------------------- */
var WIPE_PHRASE = 'WIPE ALL DATA';

router.post('/wipe', asyncHandler(function (req, res) {
  var body = req.body || {};
  if (body.confirm !== WIPE_PHRASE) {
    return res.status(400).json({ error: 'Type ' + WIPE_PHRASE + ' to confirm', code: 'CONFIRM_REQUIRED' });
  }
  if (typeof body.password !== 'string' || !body.password) {
    return res.status(400).json({ error: 'Enter your password to confirm', code: 'PASSWORD_REQUIRED' });
  }
  var actor = audit.actorOf(req);

  return userModel.findCredentialById(req.auth.id).then(function (hash) {
    return hash ? passwords.verify(body.password, hash) : false;
  }).then(function (ok) {
    if (!ok) {
      audit.record(actor, 'wipe.refused', { ip: req.ip, summary: 'Wipe All Data refused: wrong password' });
      return res.status(403).json({ error: 'That password is not correct. Nothing was wiped.', code: 'WRONG_PASSWORD' });
    }

    var blobUrls = [];
    return db.transaction(function (client) {
      var out = {};
      function count(sql, key) {
        return client.query(sql).then(function (r) { out[key] = r.rowCount; });
      }
      return count('delete from app_cleaning_tasks', 'cleaningTasks')
        .then(function () { return count('delete from app_checklists', 'checklists'); })
        .then(function () { return count('delete from app_labels', 'labels'); })
        .then(function () { return count('delete from app_notifications', 'notifications'); })
        .then(function () { return client.query('delete from app_photos returning url'); })
        .then(function (r) {
          out.photos = r.rowCount;
          blobUrls = r.rows.map(function (x) { return x.url; }).filter(Boolean);
        })
        .then(function () { return count('delete from bk_tasks', 'tasks'); })
        .then(function () { return count('delete from bk_products', 'products'); })
        .then(function () { return client.query('select count(*)::int as n from app_users'); }).then(function (r) { out.accounts_kept = r.rows[0].n; })
        .then(function () { return client.query('select count(*)::int as n from app_checklist_items where active = true'); })
        .then(function (r) { out.checklist_items_kept = r.rows[0].n; })
        .then(function () {
          /* Days before today no longer count as Missed: their records are gone. */
          return settings.set('checklist_tracking_since', windows.istParts(Date.now()).ymd, client);
        })
        .then(function () {
          /* The time of this row is the new sync epoch. */
          return client.query(
            'insert into app_admin_audit (action, actor_id, actor_uid, actor_role, actor_name, ip, summary, detail) ' +
            "values ('wipe', $1, $2, $3, $4, $5, $6, $7) returning at",
            [req.auth.id, req.auth.uid, req.auth.role, actor.name, req.ip || null,
              'Wiped all application data (' + out.cleaningTasks + ' tasks, ' + out.checklists + ' checklists, ' +
              out.labels + ' labels, ' + out.photos + ' photos). Accounts, settings and the audit log were kept.', out]);
        })
        .then(function (r) { out.at = new Date(r.rows[0].at).toISOString(); return out; });
    }).then(function (out) {
      return photos.deleteBlobs(blobUrls).then(deleteLegacyPhotoFiles).then(function (n) {
        out.photoFiles = blobUrls.length + n;
        console.warn('[admin] ' + req.auth.uid + ' WIPED all data: ' + JSON.stringify(out));
        res.json({ wiped: out });
      });
    });
  });
}));

/* Photos the older app uploaded to the Blob store under photos/. */
function deleteLegacyPhotoFiles() {
  if (!config.blobToken) return Promise.resolve(0);
  var blob;
  try { blob = require('@vercel/blob'); } catch (e) { return Promise.resolve(0); }
  var count = 0;
  function page(cursor) {
    return blob.list({ prefix: 'photos/', cursor: cursor, limit: 1000, token: config.blobToken }).then(function (r) {
      var urls = r.blobs.map(function (b) { return b.url; });
      return (urls.length ? blob.del(urls, { token: config.blobToken }) : Promise.resolve()).then(function () {
        count += urls.length;
        return r.hasMore ? page(r.cursor) : count;
      });
    });
  }
  return page(undefined).catch(function (err) {
    console.error('[admin] wipe: photo files could not all be deleted:', err.message);
    return count;
  });
}

module.exports = router;
