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

echo "Starting OIDC password flow (demo/demo)..."
node "$ROOT_DIR/dist/bin/mcp-sso.js" \
  --protocol oidc \
  --flow password \
  --token-endpoint http://localhost:8080/realms/mcp-sso/protocol/openid-connect/token \
  --client-id mcp-sso-cli \
  --username demo \
  --password demo \
  --output /tmp/keycloak.env \
  --type xsuaa

echo "Running SAML pure flow (auto login)..."
SAML_RESPONSE="$(node "$ROOT_DIR/tests/keycloak/saml-auto.js")"

node "$ROOT_DIR/dist/bin/mcp-sso.js" \
  --protocol saml2 \
  --flow pure \
  --idp-sso-url http://localhost:8080/realms/mcp-sso/protocol/saml \
  --sp-entity-id mcp-sso-saml \
  --assertion "$SAML_RESPONSE" \
  --assertion-flow assertion \
  --output /tmp/keycloak-saml.env \
  --type abap \
  --service-url http://localhost:4004 \
  --destination keycloak-saml

echo "Done. Outputs:"
echo "  /tmp/keycloak.env"
echo "  /tmp/keycloak-saml.env"
