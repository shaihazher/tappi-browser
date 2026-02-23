# Tappi Browser CLI — Scripting Guide

This guide covers using `tappi-browser` in shell scripts, automation pipelines, and programmatic contexts. The key feature is `--json` mode, which turns every command into a structured JSON producer suitable for piping, parsing, and composing with other tools.

---

## `--json` Flag

By default, `tappi-browser` formats output for humans (colors, labels, indentation). The `--json` flag switches to **raw JSON output** — no colors, no labels, just machine-parseable data.

**Placement:** `--json` must come **before** the command name.

```bash
tappi-browser --json status
tappi-browser --json tabs
tappi-browser --json ask "What is on this page?"
tappi-browser --json tool page_text '{}'
tappi-browser --json config get
```

### Color / TTY Detection

Even without `--json`, colors are automatically disabled when:

- Output is piped (`tappi-browser tabs | cat` → no ANSI codes)
- `NO_COLOR` environment variable is set

This means basic piping works without `--json`. Use `--json` when you need structured data.

---

## Exit Codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| `0`  | Success                                     |
| `1`  | Error (connection failure, API error, bad args) |

```bash
tappi-browser status && echo "Browser is running"
tappi-browser open https://example.com || echo "Failed to navigate"
```

---

## Output Channels

- **Stdout:** Normal command output (JSON or formatted text)
- **Stderr:** Error messages (printed with `✗` prefix in human mode)

This allows clean piping:

```bash
tappi-browser --json tabs 2>/dev/null | jq '.[0].title'
```

---

## Using with `jq`

[jq](https://jqlang.github.io/jq/) is the ideal companion for processing `--json` output.

### Get the active tab ID

```bash
tappi-browser --json status | jq -r '.activeTabId'
```

### List all tab titles

```bash
tappi-browser --json tabs | jq -r '.[].title'
```

### Get the URL of the active tab

```bash
ACTIVE=$(tappi-browser --json status | jq -r '.activeTabId')
tappi-browser --json tabs | jq -r --arg id "$ACTIVE" '.[] | select(.id == $id) | .url'
```

### Count open tabs

```bash
tappi-browser --json tabs | jq 'length'
```

### Check if an API key is configured

```bash
HAS_KEY=$(tappi-browser --json status | jq -r '.hasApiKey')
if [ "$HAS_KEY" = "true" ]; then
  echo "API key is configured"
fi
```

### Extract agent response text

```bash
tappi-browser --json ask "What is the page title?" | jq -r '.response'
```

### Filter page text with jq

```bash
tappi-browser --json text | jq -r '.result' | grep -i "price"
```

---

## Using with `grep`

For simpler filtering, `grep` works well on text output:

```bash
# Find all elements containing "submit"
tappi-browser elements | grep -i submit

# Find lines in page text containing a keyword
tappi-browser text | grep "Error"
```

Or use the built-in `--grep` filter (more efficient — filtering is done on the browser side):

```bash
tappi-browser elements --grep submit
tappi-browser text --grep error
```

---

## Streaming with `--stream`

For the `ask` command, `--stream` enables SSE streaming — output is written to stdout incrementally:

```bash
# Stream and pipe through a pager
tappi-browser ask --stream "Explain everything on this page" | less

# Stream to a file
tappi-browser ask --stream "Summarize this article" > summary.txt

# Stream and also show a word count when done
tappi-browser ask --stream "List all links on this page" | tee links.txt | wc -l
```

Streaming and `--json` can be combined, but `--stream` in that case still writes raw text chunks (not JSON lines) because the SSE payload is already text:

```bash
# --json doesn't meaningfully change --stream output; omit it for streaming
tappi-browser ask --stream "What is this page about?"
```

---

## Automation Scripts

### Script 1 — Open a URL, extract text, grep for a keyword

```bash
#!/usr/bin/env bash
set -euo pipefail

KEYWORD="${1:-error}"
URL="${2:-https://example.com}"

# Open the page
tappi-browser open "$URL"
sleep 2  # wait for page load

# Extract text and grep
tappi-browser text --grep "$KEYWORD"
```

Usage: `./check-page.sh "404" "https://mysite.com/status"`

---

### Script 2 — Screenshot all open tabs

```bash
#!/usr/bin/env bash
set -euo pipefail

OUTDIR="${1:-/tmp/tab-screenshots}"
mkdir -p "$OUTDIR"

# Get all tab IDs and titles
TABS=$(tappi-browser --json tabs)
COUNT=$(echo "$TABS" | jq 'length')

echo "Screenshotting $COUNT tab(s)..."

for i in $(seq 0 $((COUNT - 1))); do
  TITLE=$(echo "$TABS" | jq -r ".[$i].title" | tr '/ ' '_')
  TAB_ID=$(echo "$TABS" | jq -r ".[$i].id")

  # Switch to tab
  tappi-browser tab switch "$i" 2>/dev/null || true
  sleep 0.5

  # Take screenshot
  RESULT=$(tappi-browser --json screenshot)
  SRC_PATH=$(echo "$RESULT" | jq -r '.path')

  # Copy to output dir with meaningful name
  cp "$SRC_PATH" "$OUTDIR/${i}-${TITLE}.png"
  echo "  [$i] $TITLE → $OUTDIR/${i}-${TITLE}.png"
done

echo "Done."
```

---

### Script 3 — Ask the agent, save response to file

```bash
#!/usr/bin/env bash
set -euo pipefail

QUESTION="$*"
if [ -z "$QUESTION" ]; then
  echo "Usage: ask-and-save.sh <question>"
  exit 1
fi

OUTFILE="response-$(date +%Y%m%d-%H%M%S).txt"

tappi-browser ask --stream "$QUESTION" | tee "$OUTFILE"

echo
echo "Response saved to: $OUTFILE"
```

---

### Script 4 — Check if browser is running before proceeding

```bash
#!/usr/bin/env bash

if ! tappi-browser status &>/dev/null; then
  echo "Tappi Browser is not running. Please start it first."
  exit 1
fi

echo "Browser is running. Proceeding..."
tappi-browser open https://example.com
```

---

### Script 5 — Search a site using page interaction

```bash
#!/usr/bin/env bash
set -euo pipefail

QUERY="${1:-tappi browser}"
SITE="${2:-https://duckduckgo.com}"

tappi-browser open "$SITE"
sleep 1

# Find search input (index may vary — adjust after running `elements`)
ELEMENTS=$(tappi-browser --json elements | jq -r '.result')
echo "Elements:"
echo "$ELEMENTS"

# Find the index of the search input
SEARCH_IDX=$(echo "$ELEMENTS" | grep -i "search\|query\|q]" | head -1 | awk '{print $1}')
if [ -z "$SEARCH_IDX" ]; then
  echo "Could not find search box. Trying index 0..."
  SEARCH_IDX=0
fi

tappi-browser type "$SEARCH_IDX" "$QUERY"
tappi-browser tool page_keys '{"keys": "Return"}'
sleep 2

tappi-browser text
```

---

### Script 6 — Monitor a config flag and alert

```bash
#!/usr/bin/env bash
# Check if developer mode is on and warn

DEV_MODE=$(tappi-browser --json status | jq -r '.developerMode')

if [ "$DEV_MODE" = "true" ]; then
  echo "⚠️  WARNING: Tappi Browser is running in Developer Mode."
  echo "   Shell exec and extended tools are enabled."
fi
```

---

### Script 7 — Pipe `tools` output into `fzf` for interactive tool selection

```bash
#!/usr/bin/env bash
# Requires: fzf

SELECTED=$(tappi-browser --json tools | jq -r '.[] | "\(.name)\t\(.description)"' | \
  fzf --delimiter='\t' --with-nth=1 --preview='echo {2}' | \
  awk '{print $1}')

if [ -z "$SELECTED" ]; then
  echo "No tool selected."
  exit 0
fi

echo "Running tool: $SELECTED"
read -r -p "JSON args (or press Enter for {}): " ARGS
ARGS="${ARGS:-{}}"

tappi-browser tool "$SELECTED" "$ARGS"
```

---

### Script 8 — Close all non-Aria tabs

```bash
#!/usr/bin/env bash
set -euo pipefail

TABS=$(tappi-browser --json tabs)
COUNT=$(echo "$TABS" | jq 'length')

echo "Found $COUNT tab(s). Closing non-Aria tabs..."

for i in $(seq 0 $((COUNT - 1))); do
  IS_ARIA=$(echo "$TABS" | jq -r ".[$i].isAria")
  TITLE=$(echo "$TABS" | jq -r ".[$i].title")
  IDX=$((COUNT - 1 - i))  # close from the end to preserve indices

  if [ "$IS_ARIA" = "false" ]; then
    tappi-browser tab close "$IDX" 2>/dev/null && echo "  Closed: $TITLE" || true
  else
    echo "  Skipped (Aria): $TITLE"
  fi
done

echo "Done."
```

---

## Environment Tips

### Disable colors permanently

```bash
export NO_COLOR=1
```

### Use in CI/CD

The `--json` flag plus exit codes make `tappi-browser` CI-friendly:

```yaml
# GitHub Actions example
- name: Check browser status
  run: tappi-browser --json status | jq -e '.hasApiKey'
  # jq -e exits 1 if value is false/null
```

### Combine with `timeout`

Long `ask` calls may take a while. Wrap with `timeout` for safety:

```bash
timeout 120 tappi-browser ask "Analyze this entire page in detail"
```

### Read token directly for use with curl

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18901/api/status
```

The CLI and raw curl are interchangeable — use whichever is more convenient for your script.

---

## See Also

- [CLI Overview](./overview.md) — installation, auth, global flags
- [CLI Commands](./commands.md) — full command reference
- [API Endpoints](../api/endpoints.md) — raw HTTP API (for curl-based scripts)
- [SSE Streaming](../api/sse-streaming.md) — consuming `--stream` programmatically
