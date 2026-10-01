#!/usr/bin/env bash
# Starts the broker's test stand — UAA and Keycloak — and waits until both
# answer. Their configuration is committed under tests/stand/, so a fresh clone
# needs nothing but Docker.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${UAA_PORT:-8080}"
KC_PORT="${KEYCLOAK_PORT:-8081}"

UAA_PORT="$PORT" KEYCLOAK_PORT="$KC_PORT" docker compose up -d

wait_for() { # name url
  for _ in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$2")" = 200 ]; then
      echo "$1 is up: $2"
      return 0
    fi
    sleep 2
  done
  echo "$1 did not come up; see: docker compose -f packages/auth-broker/tests/stand/compose.yaml logs" >&2
  return 1
}
wait_for UAA "http://localhost:$PORT/uaa/healthz"
wait_for Keycloak "http://localhost:$KC_PORT/realms/test/.well-known/openid-configuration"
