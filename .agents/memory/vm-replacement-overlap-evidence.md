---
name: VM replacement overlap evidence
description: How to distinguish a real full compute restart and replacement overlap from aggregate uptime changes.
---

Aggregate `compute_uptime` reset or decline can suggest that a new VM became visible, but it does not prove a user-triggered full restart or old/new instance overlap when telemetry has no instance ID or instance count. Use provider lifecycle events or instance-scoped logs for that claim. For database connection peaks, combine complete per-process pool lifecycle logs across outgoing and incoming instances; process-local peaks are not an overlap total.

Even when every page of a provider log query is returned without truncation, a per-process event-sequence gap shows that the lifecycle capture is incomplete. Pagination completeness does not prove that every emitted event was retained.

**Why:** The available production metrics showed uptime changes but exposed no instance identity/count, while pool logs measured only local peaks and contained a sequence gap despite complete pagination.

**How to apply:** During a VM rollout pilot, verify which instance-level metrics are available before relying on uptime. Include per-process sequence numbers in lifecycle logs, and report restart/overlap as unverified until lifecycle or complete instance-scoped evidence supports it.
