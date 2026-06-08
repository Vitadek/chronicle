#!/usr/bin/env bash
#
# Build the Chronicle Android APK in Docker — no host Flutter/Android SDK.
# Output: ./build-apk/*.apk  (sideload app-arm64-v8a-release.apk on a phone)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building Chronicle APK in Docker (this can take a while on first run)…"
DOCKER_BUILDKIT=1 docker build \
  -f apk.Dockerfile \
  --target export \
  --output "type=local,dest=build-apk" \
  .

echo
echo "Built APKs:"
ls -lh build-apk/*.apk
