---
name: Station-count requirement scaling
description: How saved station case counts affect live requirements for a production run.
---

Live requirements use only the reviewed plan captured with the run. For each requirement area, scale remaining quantities from the lowest completed-case count that a station has explicitly saved in that area. Ignore stations without a saved count; a saved zero is a real report. Keep original source quantities and unresolved units visible, and never deduct inventory as part of this calculation.

**Why:** An unreported station should not prevent a reported count from updating the run, while using the lowest reported count avoids assuming that all reported stations have completed more cases than the least-progressed station.

**How to apply:** Preserve this boundary when changing station counts or live planning. Make inventory adjustments a separately confirmed workflow, not a side effect of requirement recalculation.
