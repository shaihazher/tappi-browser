# Tappi Browser — CLI Overview

`tappi-browser` is the official command-line interface for Tappi Browser. It provides shell access to every feature of the browser: tab management, page interaction, AI agent, browser controls, tool execution, and configuration — all without leaving the terminal.

---

## What the CLI Does

The CLI is a thin HTTP client that reads the API token from disk and talks to the local REST API server on port `18901`. Every CLI command maps 1:1 to an [API endpoint](../api/endpoints.md). Output is formatted for humans by default; pass `--json` for machine-readable output.

---

## Installation

The CLI ships as part of the Tappi Browser distribution. When Tappi Browser is installed, `tappi-browser` is available as a command in your `PATH`.

**Verify installation:**

```bash
tappi-browser help
```

If the binary is not in your PATH, look for it in the Tappi Browser app resources. On macOS:

```bash
/Applications/Tappi\ Browser.app/Contents/Resources/bin/tappi-browser help
```

---

## Prerequisites

Tappi Browser **must be running** before using the CLI. The CLI connects to the local API server that the browser starts on launch. If the browser is not running:

```
✗ Cannot connect to Tappi Browser. Is it running?
```

---

## Connecting to the API Server

The CLI automatically:

1. Reads the API token from `~/.tappi-browser/api-token`
2. Connects to `http://127.0.0.1:18901`
3. Sends `Authorization: Bearer <token>` on every request

No configuration is required. As long as Tappi Browser is running and the token file exists, the CLI works.

**Token location:**

```
~/.tappi-browser/api-token
```

This file is created automatically by the browser on first launch (mode `0600`, owner-readable only).

---

## Authentication

The CLI uses the same **Bearer token** authentication as the raw API. The token is read automatically — you never need to pass it manually. If the token file is missing:

```
✗ No API token found. Make sure Tappi Browser is running.
   Token location: /Users/you/.tappi-browser/api-token
```

If the token doesn't match (e.g. browser was reinstalled):

```
✗ Unauthorized: API token mismatch. Is Tappi Browser running?
```

In both cases, restart Tappi Browser to regenerate/reload the token.

---

## Basic Usage

```
tappi-browser <command> [args...]
tappi-browser --json <command>
tappi-browser --stream ask <message>
```

**Get help:**

```bash
tappi-browser help
tappi-browser --help
tappi-browser -h
```

---

## Global Flags

These flags must be placed **before** the command name:

| Flag       | Description                                               |
| ---------- | --------------------------------------------------------- |
| `--json`   | Output raw JSON instead of formatted human-readable text  |
| `--stream` | Enable SSE streaming (only used with the `ask` command)   |

```bash
tappi-browser --json status
tappi-browser --json tabs
tappi-browser --stream ask "What is on this page?"
```

---

## ANSI Color Output

The CLI uses ANSI colors for human-readable output. Colors are automatically disabled when:

- The output is not a TTY (e.g. piped to a file or another command)
- The `NO_COLOR` environment variable is set

This means `tappi-browser tabs | cat` will produce plain text automatically.

---

## Exit Codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| `0`  | Success                                          |
| `1`  | Error — connection failure, bad args, API error  |

All errors are printed to `stderr`. Normal output goes to `stdout`.

---

## Quick Command Reference

```
tappi-browser status                   # Show browser status
tappi-browser tabs                     # List all tabs
tappi-browser tab new [url]            # Open new tab
tappi-browser tab close [index]        # Close tab
tappi-browser tab switch <index>       # Switch to tab
tappi-browser open <url>               # Navigate current tab
tappi-browser back                     # Go back
tappi-browser forward                  # Go forward
tappi-browser elements [--grep text]   # Index page elements
tappi-browser click <index>            # Click element
tappi-browser type <index> <text>      # Type into element
tappi-browser text [--grep text]       # Extract page text
tappi-browser screenshot               # Take screenshot
tappi-browser ask <message>            # Ask the AI agent
tappi-browser ask --stream <message>   # Streaming agent response
tappi-browser dark-mode on|off         # Toggle dark mode
tappi-browser zoom in|out|reset|<pct>  # Set zoom
tappi-browser find <text>              # Find in page
tappi-browser tools                    # List all tools
tappi-browser tool <name> [json-args]  # Call a specific tool
tappi-browser config get               # Show config
tappi-browser config set <key> <val>   # Update config
tappi-browser exec <command>           # Run shell command (dev mode)
```

---

## Further Reading

- [Command Reference](./commands.md) — every command documented in detail
- [Scripting Guide](./scripting.md) — `--json`, piping, jq, automation scripts
- [API Overview](../api/overview.md) — the HTTP API the CLI wraps
- [API Endpoints](../api/endpoints.md) — raw API endpoint reference
