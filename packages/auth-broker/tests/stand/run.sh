#!/usr/bin/env bash
# One command for the stand suites of both packages: start UAA and Keycloak in
# Docker, run the library's suites (packages/auth-broker/src/__tests__/stand)
# and the CLI's (packages/auth-broker-cli/src/__tests__/stand, which run the
# built `mcp-auth` bin, built here first) against them, and stop them again —
# the same locally and in CI. Run it as `npm run test:stand` from the
# repository root or from packages/auth-broker; extra arguments go to both
# Jest runs (`-t "<case>"`).
#
# Whoever starts a server stops it, per service: one that was already running
# (from `npm run stand:up`, or started by hand) is left running, and only the
# ones this script started are removed. STAND_KEEP=1 keeps those too.
#
# Written for Bash 3.2, the /bin/bash macOS still ships: no associative arrays,
# and no arrays at all — an empty one is "unbound" under `set -u` there.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/../.." && pwd)"
CLI_PACKAGE="$(cd "$PACKAGE/../auth-broker-cli" && pwd)"
cd "$HERE"
PORT="${UAA_PORT:-8080}"
KC_PORT="${KEYCLOAK_PORT:-8081}"
SERVICES="uaa keycloak"

wanted_address() { # service
  case "$1" in
    uaa) echo "127.0.0.1:$PORT" ;;
    keycloak) echo "127.0.0.1:$KC_PORT" ;;
  esac
}

# Space-separated names of the services this run starts, and so owns.
started=""
for service in $SERVICES; do
  if [ -z "$(docker compose ps -q --status running "$service" 2>/dev/null)" ]; then
    started="$started $service"
  fi
done
started="${started# }"

# A server that is already running is not ours to change. `docker compose up`
# would recreate it if the requested port differs from the one it is published
# on, so refuse instead — before anything is started or trapped.
for service in $SERVICES; do
  case " $started " in
    *" $service "*) ;;
    *)
      actual="$(docker compose port "$service" 8080 2>/dev/null || true)"
      wanted="$(wanted_address "$service")"
      if [ "$actual" != "$wanted" ]; then
        echo "$service is already running on $actual, not $wanted;" \
          "stop it (npm run stand:down) or run with its port" >&2
        exit 1
      fi
      ;;
  esac
done

stop() {
  status=$?
  # On failure, print the servers' logs before anything removes the
  # containers — after `down` there is nothing left to read, locally or in CI.
  if [ "$status" -ne 0 ]; then
    echo "--- stand logs (last 200 lines per service) ---" >&2
    docker compose -f "$HERE/compose.yaml" logs --no-color --tail 200 >&2 || true
  fi
  if [ -n "$started" ] && [ "${STAND_KEEP:-0}" != 1 ]; then
    if [ "$started" = "$SERVICES" ]; then
      "$HERE/down.sh" >/dev/null 2>&1 || echo "could not stop the stand" >&2
    else
      # Word splitting is intended: $started is a list of service names.
      # shellcheck disable=SC2086
      docker compose -f "$HERE/compose.yaml" rm --stop --force $started \
        >/dev/null 2>&1 || echo "could not stop: $started" >&2
    fi
  fi
  exit "$status"
}
trap stop EXIT

UAA_PORT="$PORT" KEYCLOAK_PORT="$KC_PORT" "$HERE/up.sh"
# The CLI's suites run its dist: built (with the library it references) before
# any suite, so a build failure ends the run first.
(cd "$CLI_PACKAGE" && npm run build)
for suites in "$PACKAGE" "$CLI_PACKAGE"; do
  (cd "$suites" &&
    UAA_URL="http://localhost:$PORT/uaa" \
      KEYCLOAK_URL="http://localhost:$KC_PORT/realms/test" \
      npm test -- src/__tests__/stand "$@")
done
