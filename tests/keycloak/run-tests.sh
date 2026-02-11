#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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
  --output /tmp/keycloak-saml.env \
  --type abap

echo "Done. Outputs:"
echo "  /tmp/keycloak.env"
echo "  /tmp/keycloak-saml.env"
