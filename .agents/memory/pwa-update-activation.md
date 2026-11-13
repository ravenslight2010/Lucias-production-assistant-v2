---
name: PWA update activation
description: A verified pattern for keeping waiting service-worker updates user-confirmed and reliable.
---

Send the waiting worker's skip-waiting message only after an operator chooses the update. The worker should keep activation alive with `event.waitUntil(self.skipWaiting())`, and the page should reload after activation as well as listen for `controllerchange`.

**Why:** A production Chromium check left a waiting worker in the installed state when using a bare skip-waiting message, and relying only on `controllerchange` did not refresh the open page.

**How to apply:** When changing Lucia's prompt-mode service worker, preserve the message lifetime and activation-state refresh path. Never turn on automatic worker replacement or automatic page reloads.
