#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

image=$1
container="chronicle-smoke-${FORGEJO_RUN_ID:-local}-$$"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach \
  --name "$container" \
  --env AUTH_MODE=token \
  --env AUTH_TOKEN=chronicle-ci-smoke-token \
  "$image" >/dev/null

attempt=0
while [ "$attempt" -lt 60 ]; do
  if docker exec "$container" \
      wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    docker exec "$container" \
      wget -qO- \
      --header='Authorization: Bearer chronicle-ci-smoke-token' \
      http://127.0.0.1:3000/api/manuscripts >/dev/null
    echo "PASS: container started and served an authenticated API request."
    exit 0
  fi

  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then
    break
  fi

  attempt=$((attempt + 1))
  sleep 1
done

echo "FAIL: Chronicle container did not become healthy." >&2
docker logs "$container" >&2 || true
exit 1
