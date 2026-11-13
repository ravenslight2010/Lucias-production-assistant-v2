---
name: end-to-end-task-ownership
description: "Creates and carries project tasks through to a verified outcome while avoiding routine follow-ups. Use when the user asks to create, add, draft, refine, assign, pick up, continue, or complete a project task; asks what tasks remain or what to do next; discusses task queues, follow-up tasks, task drafts, or canceled tasks; or asks whether discovered work belongs in an existing task. Also use while executing an assigned task when related work is discovered."
---

# End-to-End Task Ownership

## Purpose

The user's preference is for each task to do as much as possible toward its
complete requested outcome, rather than stopping early and generating a chain
of follow-up drafts. Apply this alongside the project-task and follow-up
instructions; it does not override platform rules, safety requirements, or
the user's approval boundaries.

## When to Use

- Creating or refining a project task
- Executing an assigned task
- Deciding whether discovered work belongs in the current task or a follow-up
- Reviewing follow-up suggestions before presenting them

## Create Complete Tasks

1. Read the relevant project-task guidance and inspect the existing task queue
   before proposing work.
2. Define one end-to-end user outcome with observable completion criteria.
   Include work that is necessary for that outcome, such as connected UI and
   API behavior, persistence, validation, error handling, and verification.
3. Keep implementation steps and minor subproblems in the task's internal
   checklist. Prefer one coherent task over separate tasks for each layer,
   test, or cleanup step.
4. Split work only when deliverables are genuinely independent, a dependency
   must be completed first, or the task cannot reasonably be owned as one
   outcome. Check for duplicates before proposing anything.

## Execute End to End

- Read the assigned task's full description and inspect the existing
  implementation before deciding its boundaries.
- When newly discovered work is necessary to make the requested outcome
  correct, safe, usable, and verifiable, add it to the current task's internal
  checklist and complete it when feasible.
- Include relevant regression tests, error states, and required integration
  work in the current task rather than deferring them as routine follow-ups.
- Do not expand into optional enhancements or unrelated work. If completing
  the outcome requires a materially different product decision, permission,
  or access that is unavailable, explain the blocker and ask the user.
- Do not attempt to change accepted task metadata when the task system does
  not allow it. Track the work internally and report any material scope
  clarification plainly.
- Verify the whole requested outcome before reporting completion.

## Keep Follow-Ups Rare and Useful

- Do not create a follow-up for work already required by the current outcome,
  a fix that can be made safely now, routine test coverage, or ordinary
  cleanup.
- Do not turn each discovery into another task, create a task to plan a task,
  or start a recursive chain of follow-up suggestions.
- Suggest separate work only when it is a distinct user-valued outcome outside
  the agreed scope, a real blocker or dependency prevents completion, or a
  decision only the user can make is needed.
- Before suggesting separate work, check that it is not already covered by
  the current task or an existing task. Keep the suggestion focused and
  self-contained.
- If no separate item clearly meets these criteria, finish without a
  follow-up suggestion.

## Example

For a request to add a production CSV import, the task should include the
necessary import flow, validation, persistence, user-visible errors, and
tests. Do not finish the import and create separate routine tasks for
validation, error handling, or tests. A distinct later feature may be
suggested only if it is outside the import outcome and independently valuable.
