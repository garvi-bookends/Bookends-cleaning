'use strict';
/* ---------------------------------------------------------------------------
   Daily checklist time windows — the single definition the server trusts.

   Every kitchen is in India, so the windows are wall-clock times in IST
   (Asia/Kolkata, UTC+05:30). India has no daylight saving, so IST is a fixed
   offset and is computed arithmetically here rather than through the host's
   time-zone database. That keeps the answer identical on a Vercel function
   (which runs in UTC), a Windows dev machine and a phone set to any zone.

   The same logic is duplicated in index.html between the
   CHECKLIST-WINDOWS-BEGIN / END markers, because the frontend is one file
   with no build step. `npm test` runs both copies against the same cases so
   they cannot drift apart.

   Windows are half-open: [start, end). Lunch at 13:29 is open, at 13:30 it
   is closed.

   CLOSING crosses midnight (22:00 → 01:00). A plain `start <= now < end`
   test would never be true for it, so an overnight window is open when the
   time is after the start OR before the end. Its "shift date" is the day it
   STARTED: 00:30 on 1 Oct belongs to the 30 Sep closing shift.
   --------------------------------------------------------------------------- */

var IST_OFFSET_MIN = 330;          // +05:30
var DAY_MS = 86400000;

var WINDOWS = [
  { type: 'LUNCH',   label: 'Lunch Checklist',   start: 12 * 60,      end: 13 * 60 + 30 },
  { type: 'DINNER',  label: 'Dinner Checklist',  start: 17 * 60,      end: 18 * 60 },
  { type: 'CLOSING', label: 'Closing Checklist', start: 22 * 60,      end: 1 * 60 }
];

var TYPES = WINDOWS.map(function (w) { return w.type; });

function byType(type) {
  for (var i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].type === type) return WINDOWS[i];
  return null;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* Epoch ms -> the IST calendar date and minute of the day. */
function istParts(ms) {
  var d = new Date(ms + IST_OFFSET_MIN * 60000);
  return {
    ymd: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

/* 'YYYY-MM-DD' shifted by n days. */
function addDaysYmd(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * DAY_MS);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/* The instant a given IST wall-clock minute happens on a given IST date. */
function istInstant(ymd, minutes) {
  var p = ymd.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) + (minutes - IST_OFFSET_MIN) * 60000;
}

function overnight(win) { return win.end <= win.start; }

/* Is `minutes` (0..1439, IST) inside the window? */
function isOpenAt(win, minutes) {
  if (overnight(win)) return minutes >= win.start || minutes < win.end;
  return minutes >= win.start && minutes < win.end;
}

/* When the window for a given shift date opens and closes, as instants. */
function shiftBounds(win, shiftDate) {
  return {
    startsAt: istInstant(shiftDate, win.start),
    endsAt: istInstant(overnight(win) ? addDaysYmd(shiftDate, 1) : shiftDate, win.end)
  };
}

/* Everything the UI and the API need to know about one window at one moment:
   whether it is open, which shift it belongs to, and when it next opens. */
function windowState(win, ms) {
  var now = istParts(ms);
  var open = isOpenAt(win, now.minutes);

  /* The shift this moment belongs to, or would belong to. Only the early-
     morning tail of an overnight window reaches back to yesterday. */
  var shiftDate = (overnight(win) && now.minutes < win.end) ? addDaysYmd(now.ymd, -1) : now.ymd;
  var b = shiftBounds(win, shiftDate);
  var startsAt = b.startsAt;
  var endsAt = b.endsAt;

  var nextOpensAt = null;
  if (!open) {
    nextOpensAt = istInstant(now.ymd, win.start);
    if (nextOpensAt <= ms) nextOpensAt = istInstant(addDaysYmd(now.ymd, 1), win.start);
  }

  return {
    type: win.type,
    label: win.label,
    open: open,
    shiftDate: shiftDate,
    startsAt: startsAt,
    endsAt: endsAt,
    nextOpensAt: nextOpensAt
  };
}

function allStates(ms) {
  return WINDOWS.map(function (w) { return windowState(w, ms); });
}

/* "11:30 AM" style, for messages. */
function fmtMinutes(m) {
  var h = Math.floor(m / 60) % 24, mm = m % 60;
  var ap = h < 12 ? 'AM' : 'PM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + pad2(mm) + ' ' + ap;
}

function rangeLabel(win) { return fmtMinutes(win.start) + ' to ' + fmtMinutes(win.end); }

/* ---------------------------------------------------------------------------
   No time limit. Checklists are open all day: one Lunch, one Dinner and one
   Closing per restaurant per IST calendar day, sent whenever it suits. The
   windows above are kept (the Flutter app and its tests still use them),
   but the web app and the API now judge a checklist by its day.
   --------------------------------------------------------------------------- */
function dayBounds(ymd) {
  return { startsAt: istInstant(ymd, 0), endsAt: istInstant(addDaysYmd(ymd, 1), 0) };
}

function dayState(win, ms) {
  var ymd = istParts(ms).ymd;
  var b = dayBounds(ymd);
  return { type: win.type, label: win.label, open: true, shiftDate: ymd,
    startsAt: b.startsAt, endsAt: b.endsAt, nextOpensAt: null };
}

function allDayStates(ms) {
  return WINDOWS.map(function (w) { return dayState(w, ms); });
}

module.exports = {
  dayBounds: dayBounds,
  dayState: dayState,
  allDayStates: allDayStates,
  IST_OFFSET_MIN: IST_OFFSET_MIN,
  WINDOWS: WINDOWS,
  TYPES: TYPES,
  byType: byType,
  istParts: istParts,
  istInstant: istInstant,
  addDaysYmd: addDaysYmd,
  isOpenAt: isOpenAt,
  shiftBounds: shiftBounds,
  windowState: windowState,
  allStates: allStates,
  fmtMinutes: fmtMinutes,
  rangeLabel: rangeLabel
};
