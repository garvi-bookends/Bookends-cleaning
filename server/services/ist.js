'use strict';
/* ---------------------------------------------------------------------------
   India Standard Time helpers for dates people type in.

   Forms send a wall-clock time as 'YYYY-MM-DDTHH:MM' with no zone. Every
   restaurant is in India, so it is read as IST here — on the server, from
   fixed arithmetic — rather than as whatever zone the phone happens to be in.
   --------------------------------------------------------------------------- */

var windows = require('./checklistWindows');

var LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* 'YYYY-MM-DDTHH:MM' (IST) -> epoch ms, or null if it is not a real time. */
function parseLocal(s) {
  var m = LOCAL_RE.exec(String(s || ''));
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  var ms = windows.istInstant(m[1] + '-' + m[2] + '-' + m[3], hh * 60 + mm);
  /* 31 Feb rolls over to March; refuse it rather than save a surprise. */
  var back = new Date(ms + windows.IST_OFFSET_MIN * 60000);
  if (back.getUTCDate() !== d || back.getUTCMonth() + 1 !== mo) return null;
  return ms;
}

/* epoch ms -> '10 Oct, 3:45 PM' in IST, for notification text. */
function label(ms) {
  var d = new Date(ms + windows.IST_OFFSET_MIN * 60000);
  var h = d.getUTCHours(), m = d.getUTCMinutes();
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ', ' + h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
}

module.exports = { parseLocal: parseLocal, label: label };
