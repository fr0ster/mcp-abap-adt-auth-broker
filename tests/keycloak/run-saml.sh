#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Waiting for Keycloak..."
READY=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://localhost:8080/realms/mcp-sso/.well-known/openid-configuration" >/dev/null 2>&1; then
    READY="yes"
    break
  fi
  sleep 2
done

if [ "$READY" != "yes" ]; then
  echo "Keycloak is not ready on http://localhost:8080"
  exit 1
fi

echo "Running SAML pure flow (manual login, no copy/paste)..."
SAML_OUT="/tmp/keycloak-saml-response.txt"
rm -f "$SAML_OUT"

node "$ROOT_DIR/tests/keycloak/saml-acs.js" &
ACS_PID=$!

SAML_URL="$(node "$ROOT_DIR/tests/keycloak/saml-sp.js")"

echo "Open in browser and login:"
echo "  $SAML_URL"
echo "Waiting for SAMLResponse (up to 2 minutes)..."

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60; do
  if [ -s "$SAML_OUT" ]; then
    break
  fi
  sleep 2
done

if [ ! -s "$SAML_OUT" ]; then
  kill "$ACS_PID" 2>/dev/null || true
  echo "Timed out waiting for SAMLResponse."
  echo "Check that the browser completed login and that Keycloak posted to http://localhost:3002/acs"
  exit 1
fi

SAML_RESPONSE="$(cat "$SAML_OUT")"
kill "$ACS_PID" 2>/dev/null || true

node "$ROOT_DIR/dist/bin/mcp-sso.js" \
  saml2 \
  --flow pure \
  --idp-sso-url http://localhost:8080/realms/mcp-sso/protocol/saml \
  --sp-entity-id mcp-sso-saml \
  --assertion "$SAML_RESPONSE" \
  --assertion-flow assertion \
  --output /tmp/keycloak-saml.env \
  --type abap \
  --service-url http://localhost:4004 \
  --destination keycloak-saml

echo "Done. Output:"
echo "  /tmp/keycloak-saml.env"
