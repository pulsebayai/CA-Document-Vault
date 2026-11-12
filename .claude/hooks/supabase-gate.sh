#!/usr/bin/env bash
# PreToolUse hook (Supabase connector, mcp__Supabase__*): any call aimed at a project other than dev
# (staging, prod, or an unknown ref) asks the user first. Covers what production-gate.sh can't see: migrations
# and SQL sent through the connector instead of the CLI (R1.1, 2026-11-12). Dev passes; calls with no project pass.
DEV_REF="ysddbwskljzhbjjohool"
input="$(cat)"
ref="$(printf '%s' "$input" | python3 -c 'import sys,json; print((json.load(sys.stdin).get("tool_input") or {}).get("project_id",""))' 2>/dev/null)"
tool="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null)"
[ -z "$ref" ] || [ "$ref" = "$DEV_REF" ] && exit 0
case "$ref" in
  uszjymzaggyobxwycrde) env="STAGING";;
  rryzbijeosprdxpscxsx) env="PROD (real client data)";;
  *) env="a non-dev project ($ref)";;
esac
reason="$tool on $env. Migrations: backward compatible only, applied before the PR merges, md5 = file after (architecture.md › Release & regression policy)."
python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":sys.argv[1]}}))' "$reason"
exit 0
