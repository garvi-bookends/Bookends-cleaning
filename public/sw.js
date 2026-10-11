'use strict';
/* ---------------------------------------------------------------------------
   Service worker — for notifications only.

   Phones (Android Chrome, and iPhones with the app added to the home screen)
   only show a system notification through a service worker, so the page
   registers this one and calls registration.showNotification().

   It caches nothing and handles no fetch: the app works exactly as it does
   without it. Tapping a notification brings the app forward on the task,
   checklist or label it is about (data.url, e.g. '/#n=123'), or opens it there.
   --------------------------------------------------------------------------- */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/#chk=LUNCH';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) {
        list[i].postMessage({ url: url });
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
