# Cron Jobs

Tappi Browser supports scheduled agent tasks that fire automatically on a timer. Each job runs as an isolated agent turn with full browser and tool access. Jobs are managed via agent tools (`cron_add`, `cron_list`, etc.) or through the Settings UI.

---

## Overview

- Jobs run **inside the Electron main process** — the browser must be open for jobs to fire.
- Each execution is **isolated**: its own session ID, conversation history, and output buffer. These are cleaned up after each run.
- Jobs are **persisted** to `~/.tappi-browser/cron-jobs.json` and survive restarts.
- The cron agent has access to all tools available to the regular agent (including shell tools if Developer Mode is on).
- Execution history: up to **10 most recent runs** per job (ring buffer).

---

## Schedule Kinds

There are three schedule kinds:

### `interval`

Runs every N milliseconds after the previous run completes.

```json
{
  "kind": "interval",
  "intervalMs": 3600000
}
```

Displayed as: `every 1h`, `every 30min`, `every 15s`.

### `daily`

Runs once per day at a specific local time.

```json
{
  "kind": "daily",
  "timeOfDay": "09:00"
}
```

If the browser is not running at the scheduled time, the job fires on the next startup at the next daily occurrence.

### `cron`

Standard 5-field cron expression (minutes, hours, day-of-month, month, day-of-week).

```json
{
  "kind": "cron",
  "cronExpr": "0 9 * * 1-5"
}
```

Supports: `*`, ranges (`1-5`), lists (`1,3,5`), steps (`*/15`), and combinations. Searches up to 1 year ahead for next occurrence.

---

## Creating a Job

Use the `cron_add` tool:

```
cron_add({
  name: "Morning news summary",
  task: "Navigate to news.ycombinator.com, read the top 10 stories,
         and save a markdown summary to ~/tappi-workspace/morning-news.md",
  schedule: { kind: "daily", timeOfDay: "08:30" }
})
```

Response:
```
✓ Created job "Morning news summary" (3f8a2c1b-...)
  Schedule: daily at 08:30
  Next run: Mon Feb 24 2026, 8:30:00 AM
```

The job ID is a UUID. You need it to update or delete the job.

---

## Listing Jobs

```
cron_list()
```

Output:
```
✅ Morning news summary (3f8a2c1b-...)
   Schedule: daily at 08:30
   Next: Mon Feb 24 2026, 8:30:00 AM | Last: ✓ 2h ago

⏸ Weekly report (d1f9a3b2-...)
   Schedule: every 7d
   Next: - | Last: ✗ 3d ago
```

---

## Updating a Job

```
cron_update({
  id: "3f8a2c1b-...",
  schedule: { kind: "daily", timeOfDay: "09:00" },
  enabled: false
})
```

Any combination of `name`, `task`, `schedule`, and `enabled` can be changed in one call. Rescheduling happens immediately after the update.

---

## Deleting a Job

```
cron_delete({ id: "3f8a2c1b-..." })
```

Cancels any pending timer and removes the job from persistence.

---

## Execution Model

When a job fires:

1. A new session ID is created: `cron:<job-id>:<timestamp>`.
2. The agent model and tool set are resolved from the current config (including Developer Mode flag).
3. The task prompt is prepended with:
   ```
   [Current time: Mon Feb 24 2026, 8:30 AM PST (America/Los_Angeles)]
   [Browser: <current tab state>]
   ```
4. The agent runs with `stopWhen: stepCountIs(50)` — up to 50 tool steps per job.
5. The first 200 characters of the response are saved as `lastResult`.
6. The session is cleaned up (output buffers, conversation history purged).
7. The job is rescheduled for the next occurrence.

### UI Notifications

The main window receives IPC events during job execution:
- `cron:job-running` — when a job starts.
- `cron:job-completed` — with result and duration.
- `cron:jobs-updated` — whenever the job list changes.

---

## Persistence

Jobs are stored at `~/.tappi-browser/cron-jobs.json` (or the profile-relative path if multi-profile is active). Loaded on startup. Saved on every create/update/delete and after every execution.

Run history per job (last 10 runs):
```json
{
  "at": "2026-02-24T08:30:00.000Z",
  "status": "success",
  "result": "Saved 10-story summary to morning-news.md...",
  "durationMs": 14200
}
```

---

## Examples

### Sync a file every hour
```
cron_add({
  name: "Backup workspace",
  task: "exec('rsync -avz ~/tappi-workspace/ user@server:/backups/tappi/')",
  schedule: { kind: "interval", intervalMs: 3600000 }
})
```

### Daily price check
```
cron_add({
  name: "BTC price check",
  task: "http_request({ url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot' })
         then file_append('~/tappi-workspace/prices.csv', result)",
  schedule: { kind: "daily", timeOfDay: "12:00" }
})
```

### Weekday morning briefing
```
cron_add({
  name: "Weekday briefing",
  task: "Navigate to my team dashboard, screenshot it, summarize open PRs and
         any CI failures, save to ~/tappi-workspace/briefing.md",
  schedule: { kind: "cron", cronExpr: "0 8 * * 1-5" }
})
```

---

## Implementation Reference

| Source File | Purpose |
|------------|---------|
| [`src/cron-manager.ts`](../../src/cron-manager.ts) | `addJob`, `listJobs`, `updateJob`, `deleteJob`, `executeJob`, `computeNextRun`, `nextCronOccurrence` |
| [`src/tool-registry.ts`](../../src/tool-registry.ts) | `cron_add`, `cron_list`, `cron_update`, `cron_delete` tool definitions |
