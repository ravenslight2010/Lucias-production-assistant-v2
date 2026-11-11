---
name: Station timer behavior
description: V1 station timers follow the overall production-line timer.
---

In V1, every station starts, pauses, resumes, and ends based on the production-line timer.

**Why:** The user stated this behavior while clarifying V2 station tracking.

**How to apply:** Treat the run's line timer as the source of truth and mirror its lifecycle transitions to every station; do not add independently editable station timer controls.
