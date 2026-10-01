#!/usr/bin/env bash
# Stops and removes the stand.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
