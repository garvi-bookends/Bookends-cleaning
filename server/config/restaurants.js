'use strict';
/* ---------------------------------------------------------------------------
   The 8 Bookends restaurants. Mirrors LOCATIONS in index.html and in
   server/scripts/seed.js — if a restaurant is added, add it in all three.

   The server needs its own copy to check that a task or label names a real
   restaurant, to work out which checklists were missed, and to build the
   admin dashboard row by row.
   --------------------------------------------------------------------------- */

var RESTAURANTS = [
  { id: 'SUR-PREP',    name: 'Surat Prep Kitchen',     city: 'Surat',     code: 'SPK' },
  { id: 'SUR-CAP-PIP', name: 'Capiche Piplod',         city: 'Surat',     code: 'CPP' },
  { id: 'SUR-CAP-VES', name: 'Capiche Vesu',           city: 'Surat',     code: 'CPV' },
  { id: 'SUR-AIKO',    name: 'Aiko Pal',               city: 'Surat',     code: 'AKP' },
  { id: 'AHM-PREP',    name: 'Ahmedabad Prep Kitchen', city: 'Ahmedabad', code: 'APK' },
  { id: 'AHM-CAP-AMB', name: 'Capiche Ambli',          city: 'Ahmedabad', code: 'CPA' },
  { id: 'AHM-CAP-UNI', name: 'Capiche Uni',            city: 'Ahmedabad', code: 'CPU' },
  { id: 'AHM-AIKO',    name: 'Aiko Ambli',             city: 'Ahmedabad', code: 'AKA' }
];

var IDS = RESTAURANTS.map(function (r) { return r.id; });

function isRestaurant(id) { return typeof id === 'string' && IDS.indexOf(id) > -1; }

function nameOf(id) {
  for (var i = 0; i < RESTAURANTS.length; i++) if (RESTAURANTS[i].id === id) return RESTAURANTS[i].name;
  return id || '';
}

module.exports = { RESTAURANTS: RESTAURANTS, IDS: IDS, isRestaurant: isRestaurant, nameOf: nameOf };
