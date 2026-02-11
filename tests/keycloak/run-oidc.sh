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

echo "Starting OIDC device flow (approve in browser)..."
node "$ROOT_DIR/dist/bin/mcp-sso.js" \
  --protocol oidc \
  --flow device \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa

echo "Done. Output:"
echo "  /tmp/keycloak.env"
