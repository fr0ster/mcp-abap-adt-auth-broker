#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KEY_PATH="$(cd "$(dirname "$0")" && pwd)/sso-demo.xsuaa.json"

if [ ! -f "$KEY_PATH" ]; then
  echo "Service key not found: $KEY_PATH"
  echo "Run: npm run service-key:create && npm run service-key:fetch"
  exit 1
fi

ASSERTION_FILE="/tmp/keycloak-saml-response.txt"
if [ ! -f "$ASSERTION_FILE" ]; then
  echo "SAML assertion file not found: $ASSERTION_FILE"
  echo "Run: npm run test:saml-pure"
  exit 1
fi
ASSERTION_ARG="--assertion $(cat "$ASSERTION_FILE")"

node "$ROOT_DIR/dist/bin/mcp-auth.js" \
  saml2-bearer \
  --dev \
  --service-key "$KEY_PATH" \
  --saml-metadata "$ROOT_DIR/tests/sso-demo/saml-8af623c9trial-sp.xml" \
  --output /tmp/xsuaa-sso.env \
  --type xsuaa \
  $ASSERTION_ARG
