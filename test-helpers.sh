#!/bin/bash
# Test helpers for Phase 8.9 CLI testing
# Usage: source test-helpers.sh

export TOKEN=$(cat ~/.tappi-browser/api-token)
export API="http://127.0.0.1:18901"

# Call a tool via passthrough
tool() {
  local name="$1"
  local body="${2:-{}}"
  curl -s "$API/api/tools/$name" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
}

# GET endpoint
api_get() {
  curl -s "$API$1" -H "Authorization: Bearer $TOKEN"
}

# POST endpoint  
api_post() {
  local path="$1"
  local body="${2:-{}}"
  curl -s "$API$path" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
}

# DELETE endpoint
api_delete() {
  curl -s -X DELETE "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "${2:-{}}"
}

# Get active tab ID (non-Aria)
active_tab() {
  api_get /api/tabs | python3 -c "import sys,json; tabs=json.load(sys.stdin); t=[x for x in tabs if x.get('active') and not x.get('isAria')]; print(t[0]['id'] if t else '')" 2>/dev/null
}

# Navigate active tab
nav() {
  tappi-browser navigate "$1" 2>&1
  sleep 2
}

# Log test result
pass() { echo "✅ PASS: $1"; }
fail() { echo "❌ FAIL: $1 — $2"; }
