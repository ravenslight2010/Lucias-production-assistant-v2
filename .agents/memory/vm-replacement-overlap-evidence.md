---
name: VM replacement overlap evidence
description: How to distinguish a real full compute restart and replacement overlap from aggregate uptime changes.
---

Aggregate `compute_uptime` reset or decline can suggest that a new VM became visible, but it does not prove a user-triggered full restart or old/new instance overlap when telemetry has no instance ID or instance count. Use provider lifecycle events or instance-scoped logs for that claim. For database connection peaks, combine complete per-process pool lifecycle logs across outgoing and incoming instances; process-local peaks are not an overlap total.

**Why:** The available production metrics showed uptime changes but exposed no instance identity/count, while pool logs measured only local peaks.

**How to apply:** During a VM rollout pilot, verify which instance-level metrics are available before relying on uptime, and report restart/overlap as unverified until lifecycle or complete instance-scoped evidence supports it.
