# Tappi Browser Documentation

> **40 documents · 10,897 lines · Complete reference for the Tappi Browser project**

---

## Table of Contents

### [README](README.md)
Project overview, features, quick start, supported providers.

---

### Architecture
How Tappi Browser is built — from Electron structure to the AI agent loop.

| Document | Description |
|----------|-------------|
| [Overview](architecture/overview.md) | High-level architecture, key design decisions, Mermaid diagram |
| [Electron Structure](architecture/electron-structure.md) | Main process, WebContentsView, preloads, IPC channels, sessions |
| [Agent System](architecture/agent-system.md) | Agent loop, context assembly, tool dispatch, streaming, deep mode |
| [Indexer](architecture/indexer.md) | Content preload, shadow DOM piercing, compact indexed output, grep philosophy |
| [Data Flow](architecture/data-flow.md) | End-to-end Mermaid diagrams for click, summarize, deep mode, coding, API flows |

---

### User Guide
Everything an end user needs to know.

| Document | Description |
|----------|-------------|
| [Getting Started](user-guide/getting-started.md) | Build from source, first run, API key setup |
| [Browsing](user-guide/browsing.md) | Tabs, navigation, bookmarks, find, zoom, dark mode, ad blocker |
| [Agent](user-guide/agent.md) | Talking to the AI, sidebar vs Aria tab, deep mode, coding mode |
| [Profiles](user-guide/profiles.md) | Creating profiles, switching, encrypted export/import |
| [Media](user-guide/media.md) | mpv overlay, enhanced playback, audio upscaling |
| [Settings](user-guide/settings.md) | All settings: LLM, search engine, features, dev mode, API services |
| [Keyboard Shortcuts](user-guide/keyboard-shortcuts.md) | Complete shortcut reference |
| [Privacy & Security](user-guide/privacy-security.md) | Data storage, encryption, agent access controls, no telemetry |

---

### Developer Guide
For contributors and power users.

| Document | Description |
|----------|-------------|
| [Developer Mode](developer-guide/dev-mode.md) | Enabling dev mode, shell tools, tool registry, sub-agents |
| [Coding Mode](developer-guide/coding-mode.md) | Agent teams, task lists, mailbox, worktree isolation |
| [Cron Jobs](developer-guide/cron-jobs.md) | Scheduled tasks, execution model, persistence |
| [Building from Source](developer-guide/building-from-source.md) | Clone, install, build, run, project structure |
| [Contributing](developer-guide/contributing.md) | Code style, PR process, how to add tools |

---

### API Reference
REST API for external control of the browser.

| Document | Description |
|----------|-------------|
| [Overview](api/overview.md) | Port, auth (Bearer token), rate limiting, security model |
| [Endpoints](api/endpoints.md) | All 29 REST endpoints with params, responses, curl examples |
| [SSE Streaming](api/sse-streaming.md) | Agent streaming protocol, event types, client examples |
| [Tool Passthrough](api/tool-passthrough.md) | Calling any registered tool via `/api/tools/:name` |

---

### CLI Reference
Command-line interface for scripting and automation.

| Document | Description |
|----------|-------------|
| [Overview](cli/overview.md) | Installation, prerequisites, auth, flags |
| [Commands](cli/commands.md) | All 21 CLI commands with flags, output, examples |
| [Scripting](cli/scripting.md) | `--json` output, jq recipes, automation scripts, CI/CD |

---

### Tool Reference
Every tool the AI agent can use, organized by category.

| Document | Tools | Description |
|----------|-------|-------------|
| [Overview](tools/overview.md) | — | Tool philosophy, categories, registration pattern |
| [Page Tools](tools/page-tools.md) | `elements`, `click`, `type`, `paste`, `focus`, `check`, `text`, `scroll`, `keys`, `eval`, `screenshot`, `click_xy`, `hover_xy`, `wait` | DOM interaction via indexed elements |
| [Browser Tools](tools/browser-tools.md) | `dark_mode`, `list_cookies`, `delete_cookies`, `close_tab`, `mute_tab`, `pin_tab`, `duplicate_tab`, `zoom`, `find_on_page`, `print_page`, `navigate`, `search`, `go_back`, `go_forward`, `browser_screenshot` | Browser-level controls |
| [File Tools](tools/file-tools.md) | `file_write`, `file_read`, `file_head`, `file_tail`, `file_append`, `file_delete`, `file_list`, `file_copy`, `file_move`, `file_grep` | Workspace file management |
| [HTTP Tools](tools/http-tools.md) | `http_request`, `api_key_store`, `api_key_list`, `api_key_delete`, `register_api_service` | HTTP client + API key vault |
| [Shell Tools](tools/shell-tools.md) | `exec`, `exec_bg`, `exec_status`, `exec_kill`, `exec_grep` | Shell execution (dev mode) |
| [Media Tools](tools/media-tools.md) | `media_play`, `media_status`, `media_toggle`, `media_quality`, `media_seek`, `media_volume`, `media_stop` | mpv playback control |
| [Capture Tools](tools/capture-tools.md) | `browser_screenshot`, `browser_record_start`, `browser_record_stop` | Screenshot + video recording |
| [Cron Tools](tools/cron-tools.md) | `cron_add`, `cron_list`, `cron_update`, `cron_delete` | Scheduled task management |
| [Conversation Tools](tools/conversation-tools.md) | `conversations_list`, `conversations_search`, `conversations_read` | Chat history access |
| [Browsing Data Tools](tools/browsing-data-tools.md) | `browse_history`, `browse_bookmarks`, `browse_downloads` | Browser data queries |
| [Team Tools](tools/team-tools.md) | `team_create`, `team_status`, `team_message`, `team_task_add`, `team_task_update`, `team_dissolve` | Multi-agent team orchestration |

---

### Reference

| Document | Description |
|----------|-------------|
| [Source Map](source-map/files.md) | Every source file: path, line count, exports, dependencies, dependency graph |
| [Changelog](changelog.md) | Phase-by-phase feature history (Phase 1 → Phase 8.96) |

---

*Generated 2026-02-22 · Tappi Browser Phase 8.96*
