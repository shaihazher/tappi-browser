# Cron Tools

Tools for creating, managing, and monitoring scheduled tasks. Each job runs as an isolated agent turn with full access to browser, file, HTTP, and shell tools. Jobs are persisted to `~/.tappi-browser/cron-jobs.json` and survive app restarts — but only execute while the browser is open.

---

## `cron_add`

Create a new scheduled job. The `task` field is a natural-language prompt that gets executed as an agent turn on every scheduled run.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | ✅ | Human-readable name for the job (e.g. `"Daily standup scraper"`). |
| `task` | `string` | ✅ | The prompt the agent executes on each run. Has access to all tools. |
| `schedule` | `object` | ✅ | Schedule configuration — see sub-fields below. |
| `schedule.kind` | `"interval" \| "cron" \| "daily"` | ✅ | Schedule type. |
| `schedule.intervalMs` | `number` | ❌ | **For `interval`:** milliseconds between runs. |
| `schedule.cronExpr` | `string` | ❌ | **For `cron`:** standard 5-field cron expression (`min hour dom month dow`). |
| `schedule.timeOfDay` | `string` | ❌ | **For `daily`:** time in local `"HH:MM"` format. |

### Schedule Kinds

| Kind | Example | Description |
|------|---------|-------------|
| `interval` | `intervalMs: 3600000` | Run every N milliseconds |
| `daily` | `timeOfDay: "09:00"` | Run once per day at a fixed local time |
| `cron` | `cronExpr: "0 9 * * 1-5"` | Run on a full 5-field cron schedule (weekdays at 9 AM) |

The cron parser supports `*`, ranges (`1-5`), steps (`*/2`), and comma lists (`1,3,5`).

### Returns

```
✓ Created job "Daily standup scraper" (a1b2c3d4-...)
  Schedule: daily at 09:00
  Next run: 1/16/2024, 9:00:00 AM
```

### Example — scrape a dashboard every morning

```json
{
  "name": "Morning metrics",
  "task": "Navigate to https://dashboard.example.com/metrics, take a screenshot, and save a summary of today's KPIs to ~/tappi-workspace/metrics/daily.md",
  "schedule": {
    "kind": "daily",
    "timeOfDay": "08:30"
  }
}
```

### Example — poll an API every 5 minutes

```json
{
  "name": "Uptime check",
  "task": "Make a GET request to https://api.example.com/health. If the status is not 200, write an alert to ~/tappi-workspace/alerts.log with the current timestamp and response.",
  "schedule": {
    "kind": "interval",
    "intervalMs": 300000
  }
}
```

---

## `cron_list`

List all scheduled jobs with their current status, schedule, next run time, and last result.

### Parameters

None.

### Returns

A formatted list of all jobs, or `No cron jobs configured.` if empty.

```
✅ Morning metrics (a1b2c3d4-...)
   Schedule: daily at 08:30
   Next: 1/17/2024, 8:30:00 AM | Last: ✓ 2h ago

⏸ Old report (b2c3d4e5-...)
   Schedule: every 1h
   Next: - | Last: ✗ 1d ago
```

Icons: `✅` = enabled, `⏸` = paused. Last run: `✓` = success, `✗` = error.

### Example

```json
{}
```

---

## `cron_update`

Update an existing job's name, task prompt, schedule, or enabled status. Provide only the fields you want to change.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | ✅ | Job ID (from `cron_list`). |
| `name` | `string` | ❌ | New display name. |
| `task` | `string` | ❌ | New task prompt. |
| `enabled` | `boolean` | ❌ | `true` to enable, `false` to pause/disable the job. |
| `schedule` | `object` | ❌ | New schedule (same shape as `cron_add`). Replaces the entire schedule. |

### Returns

```
✓ Updated "Morning metrics" (a1b2c3d4-...)
  Enabled: true
  Schedule: daily at 09:00
  Next: 1/17/2024, 9:00:00 AM
```

### Example — pause a job

```json
{
  "id": "a1b2c3d4-...",
  "enabled": false
}
```

### Example — change schedule to cron

```json
{
  "id": "a1b2c3d4-...",
  "schedule": {
    "kind": "cron",
    "cronExpr": "0 9 * * 1-5"
  }
}
```

---

## `cron_delete`

Permanently delete a scheduled job by ID. Clears the timer immediately.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | ✅ | Job ID to delete (from `cron_list`). |

### Returns

```
✓ Deleted job "Morning metrics" (a1b2c3d4-...)
```

Or an error if the ID was not found.

### Example

```json
{
  "id": "a1b2c3d4-..."
}
```

---

## Job Execution Context

When a job fires, the agent prompt is augmented with:

- **Current time and timezone** — `[Current time: Wed, Jan 15, 2025, 09:00 AM PST]`
- **Browser state** — active tab URL, open tab count

The job runs for up to 50 tool-calling steps. Results (first 200 chars) are stored in the job's run history (last 10 runs).

---

## See Also

- [`file_write`](./file-tools.md#file_write) / [`file_append`](./file-tools.md#file_append) — save job output to files
- [`http_request`](./http-tools.md#http_request) — make HTTP calls from within scheduled tasks
- [`conversations_list`](./conversation-tools.md#conversations_list) — review what past cron sessions produced
