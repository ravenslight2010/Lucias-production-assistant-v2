# V1 interaction patterns informing V2

This is a short, read-only reference study of the V1 `Replit` branch in
`ravenslight2010/Production-run-calculator`. It describes behavior and structure
to preserve, not code to copy.

## Observations

- V1 brought the production line into one home surface. Its fixed station
  navigation kept Run, Dough, Sauce, Front, Pack, and Warehouse within one tap
  on a floor device.
- The station panels were separate, task-specific surfaces. The home composed
  live run, dough, sauce, frontline, packaging, setup, and inventory panels
  instead of treating each as an unrelated destination.
- V1's `HomeStationTabs` shared the current run identity with station panels
  and scoped stock drafts to that run. This helped keep station work attached
  to the production context.
- The live run and its supporting dough, sauce, and packaging panels exposed
  production details in the same operational area. The user did not have to
  return to a generic dashboard between every station task.
- Manager/profile setup was distinct from ordinary run execution. The profile
  editor selected by brand and flavor, required manager access to save, and
  refreshed a matching open run after an acknowledged save.
- Management choices such as setup, inventory, mix planning, quality, staff,
  and issue review were available without replacing the floor station flow.

## V2 application

- V2 now uses a Today cockpit for active and planned work, station coverage,
  preparation readiness, quality attention, and recently completed runs.
- The selected run is remembered across operational routes, and its shared
  timer, state, connectivity, review count, and permitted lifecycle controls
  remain available in the app shell.
- The Live run navigation opens the selected run's existing detail workspace.
  Station progress, quality, requirements, and inventory actions are ordered
  before the captured product/source snapshot so active work is easier to reach.
- V2 keeps facility tenancy, revision checks, idempotency, audit records, and
  explicit offline read-only behavior. V1 credentials, database, cookies, and
  synchronization behavior are not being restored.

## Source files reviewed

- `artifacts/run-calculator/src/pages/home.tsx`
- `artifacts/run-calculator/src/components/HomeStationTabs.tsx`
- `artifacts/run-calculator/src/components/live-stations/LiveRunTabContent.tsx`
- `artifacts/run-calculator/src/components/live-stations/LiveDoughTabContent.tsx`
- `artifacts/run-calculator/src/components/live-stations/LiveSauceTabContent.tsx`
- `artifacts/run-calculator/src/components/SetupProfileEditor.tsx`

The V1 files were read from the repository's `Replit` branch for reference;
they were not copied or modified.
