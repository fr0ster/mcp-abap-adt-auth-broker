#!/usr/bin/env bash
# One command for the x509 live check: build, set up, run the suite, tear
# down — also when a test fails. The exit status is non-zero if the build,
# the setup, the tests or the teardown failed: a run that leaves resources
# behind is not a success. X509_KEEP=1 keeps the environment for another run.
# Not part of CI: it needs a BTP subaccount and a `cf login`.
#
# Run it as `npm run test:live:x509` from the repository root or from
# packages/auth-broker, with XSUAA_CF_API, XSUAA_CF_ORG and XSUAA_CF_SPACE set
# to exactly what `cf target` shows; extra arguments go to Jest
# (`-t "<case>"`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/../../.." && pwd)"
ROOT="$(cd "$PACKAGE/../.." && pwd)"
. "$HERE/lib.sh"
guard_target

# The suite runs the CLI as a user does: mcp-auth from its dist, which loads
# the broker's dist. Built before anything is created, so a broken build
# leaves nothing to tear down.
(cd "$ROOT" && npm run build >/dev/null) || {
  echo "the build failed; nothing was created — run npm run build to see why" >&2
  exit 1
}

finish() {
  status=$?
  if [ "${X509_KEEP:-0}" != 1 ]; then
    if ! "$HERE/teardown.sh"; then
      echo "teardown failed — resources may remain; run tests/live/x509/teardown.sh" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  exit "$status"
}
trap finish EXIT

"$HERE/setup.sh"
cd "$PACKAGE"
AUTH_BROKER_LIVE_X509_LOCAL="$LOCAL" \
  npm run test:live -- src/__tests__/live/x509.live.test.ts "$@"
