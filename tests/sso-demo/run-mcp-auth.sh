#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KEY_PATH="$(cd "$(dirname "$0")" && pwd)/sso-demo-key.json"

if [ ! -f "$KEY_PATH" ]; then
  echo "Service key not found: $KEY_PATH"
  echo "Run: npm run service-key:create && npm run service-key:fetch"
  exit 1
fi

node "$ROOT_DIR/dist/bin/mcp-auth.js" \
  auth-code \
  --service-key "$KEY_PATH" \
  --output /tmp/xsuaa-auth.env \
  --type xsuaa \
  --redirect-port 3001
