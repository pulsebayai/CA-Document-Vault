#!/usr/bin/env bash
# Chore ci-speed: start an EPHEMERAL local Supabase built only from supabase/migrations/ (CI's RLS job; also
# usable on a machine with Docker). Never points at dev, staging or prod.
#
#   scripts/local-db.sh start   creates a self-signed TLS cert if missing, starts the stack, prints the env
#   scripts/local-db.sh env     prints NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY / SUPABASE_SECRET_KEY / NODE_EXTRA_CA_CERTS
#   scripts/local-db.sh stop
#
# The API is served over HTTPS (supabase/config.toml [api.tls]) so links signed by Storage start with https:,
# as on the hosted projects (bulk.test.ts AC-2 asserts it). Node trusts the cert through NODE_EXTRA_CA_CERTS.
# In GitHub Actions the env lines are also appended to $GITHUB_ENV.
set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR=supabase/certs
CERT="$CERT_DIR/local-cert.pem"
KEY="$CERT_DIR/local-key.pem"
# Services the tests don't use (no Studio, Realtime, edge functions, analytics, image transforms, mail UI).
EXCLUDE=vector,imgproxy,logflare,supavisor,postgres-meta,mailpit,studio,realtime,edge-runtime

cert() {
  [ -s "$CERT" ] && [ -s "$KEY" ] && return
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -addext "basicConstraints=critical,CA:TRUE" \
    -keyout "$KEY" -out "$CERT" 2>/dev/null
}

print_env() {
  local status
  status="$(supabase status -o env)"
  # shellcheck disable=SC1090
  eval "$(printf '%s\n' "$status" | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY)=')"
  local out
  out="NEXT_PUBLIC_SUPABASE_URL=https://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY:-$ANON_KEY}
SUPABASE_SECRET_KEY=${SECRET_KEY:-$SERVICE_ROLE_KEY}
NODE_EXTRA_CA_CERTS=$PWD/$CERT"
  printf '%s\n' "$out"
  if [ -n "${GITHUB_ENV:-}" ]; then printf '%s\n' "$out" >> "$GITHUB_ENV"; fi
}

case "${1:-}" in
  start)
    cert
    start=$(date +%s)
    rc=0
    supabase start -x "$EXCLUDE" > /tmp/supabase-start.log 2>&1 || rc=$?
    tail -20 /tmp/supabase-start.log
    if [ "$rc" != 0 ]; then
      # In Actions, put the (migration) error in an annotation: readable without downloading raw logs.
      if [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::error title=local-db start::$(grep -iE 'error|failed|migration' /tmp/supabase-start.log | tail -15 | tr -d '\r' | sed ':a;N;$!ba;s/\n/%0A/g')"
      fi
      exit "$rc"
    fi
    echo "local-db: started with all migrations in $(( $(date +%s) - start )) s"
    print_env > /dev/null
    ;;
  env) print_env ;;
  stop) supabase stop --no-backup ;;
  *) echo "usage: $0 start|env|stop" >&2; exit 2 ;;
esac
