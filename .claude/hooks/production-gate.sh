#!/usr/bin/env bash
# PreToolUse hook (Bash): blocks production deploys, prod migrations and pushes to main
# unless the user explicitly approves in that moment. Exit 2 = block with message.
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"

block() { echo "BLOCKED by production-gate: $1. Ask the user for explicit approval, then they run it themselves or approve this exact command." >&2; exit 2; }

case "$cmd" in
  *"vercel --prod"*|*"vercel deploy --prod"*|*"vercel promote"*) block "production deploy (Vercel)";;
esac
if printf '%s' "$cmd" | grep -Eq 'git push( .*)? (origin )?(main|HEAD:main)( |$)|git push( .*)? --force.*main'; then block "push to main"; fi
if printf '%s' "$cmd" | grep -Eq 'supabase (db push|migration up).*(prod|staging)|--project-ref[ =][a-z]+.*(db push)'; then
  printf '%s' "$cmd" | grep -q "ysddbwskljzhbjjohool" || block "migration to a non-dev Supabase project"
fi
exit 0
