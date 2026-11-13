import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const appShellPath = new URL('index.html', self.registration.scope).pathname;
registerRoute(new NavigationRoute(createHandlerBoundToURL(appShellPath), {
  denylist: [/^\/api(?:\/|$)/],
}));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});
