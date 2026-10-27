#!/usr/bin/env bash
# Chore ci-speed: start an EPHEMERAL local Supabase built only from supabase/migrations/ (CI's RLS job; also
# usable on a machine with Docker and registry access).
#
#   scripts/local-db.sh start   creates/renews a self-signed TLS cert, starts the stack (all migrations)
#   scripts/local-db.sh env     prints the four variables the tests need, as KEY=value lines
#   scripts/local-db.sh stop
#
# In GitHub Actions, `start` also appends those variables to $GITHUB_ENV, so later steps use the local stack.
# On a laptop nothing is exported: `npm run test:db` would still read .env.local (the DEV keys). To run the
# tests against the local stack, export them first (dotenv never overrides variables already set):
#   set -a; eval "$(scripts/local-db.sh env)"; set +a; npm run test:db
#
# The API is served over HTTPS (supabase/config.toml [api.tls]) so links signed by Storage start with https:,
# as on the hosted projects (bulk.test.ts AC-2 asserts it). Node trusts the cert through NODE_EXTRA_CA_CERTS.
set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR=supabase/certs
CERT="$CERT_DIR/local-cert.pem"
KEY="$CERT_DIR/local-key.pem"
# Services the tests don't use (no Studio, Realtime, edge functions, analytics, image transforms, mail UI).
EXCLUDE=vector,imgproxy,logflare,supavisor,postgres-meta,mailpit,studio,realtime,edge-runtime

cert() {
  # Reuse a pair that is valid for at least another day; otherwise make a new one (30 days).
  if [ -s "$CERT" ] && [ -s "$KEY" ] && openssl x509 -checkend 86400 -noout -in "$CERT" > /dev/null 2>&1; then return; fi
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -addext "basicConstraints=critical,CA:TRUE" \
    -keyout "$KEY" -out "$CERT" 2>/dev/null
}

local_env() {
  local status API_URL="" ANON_KEY="" SERVICE_ROLE_KEY="" PUBLISHABLE_KEY="" SECRET_KEY=""
  status="$(supabase status -o env)"
  eval "$(printf '%s\n' "$status" | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY)=')"
  case "$API_URL" in
    https://*) ;;
    *) echo "local-db: API_URL is '$API_URL', expected https:// (is [api.tls] enabled in supabase/config.toml?)" >&2; return 1 ;;
  esac
  printf '%s\n' \
    "NEXT_PUBLIC_SUPABASE_URL=$API_URL" \
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY:-$ANON_KEY}" \
    "SUPABASE_SECRET_KEY=${SECRET_KEY:-$SERVICE_ROLE_KEY}" \
    "NODE_EXTRA_CA_CERTS=$PWD/$CERT"
}

case "${1:-}" in
  start)
    cert
    log="$(mktemp "${RUNNER_TEMP:-/tmp}/supabase-start.XXXXXX")"
    begin=$(date +%s)
    rc=0
    supabase start -x "$EXCLUDE" > "$log" 2>&1 || rc=$?
    tail -20 "$log"
    if [ "$rc" != 0 ]; then
      # In Actions, put the (migration) error in an annotation: readable without downloading raw logs.
      if [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::error title=local-db start::$(grep -iE 'error|failed|migration' "$log" | tail -15 | tr -d '\r' | sed ':a;N;$!ba;s/\n/%0A/g')"
      fi
      exit "$rc"
    fi
    secs=$(( $(date +%s) - begin ))
    echo "local-db: started with all migrations in ${secs} s"
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice title=local-db start::all migrations applied in ${secs} s"
    vars="$(local_env)"
    if [ -n "${GITHUB_ENV:-}" ]; then printf '%s\n' "$vars" >> "$GITHUB_ENV"; fi
    ;;
  env) local_env ;;
  stop) supabase stop --no-backup ;;
  *) echo "usage: $0 start|env|stop" >&2; exit 2 ;;
esac
