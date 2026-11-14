#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${SWIFT_DOCKER:-0}" == 1 ]]; then
  docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD:/workspace" -w /workspace swift:6.0 \
    bash -c 'swift build -Xswiftc -warnings-as-errors && swift test -Xswiftc -warnings-as-errors'
else
  swift build -Xswiftc -warnings-as-errors
  swift test -Xswiftc -warnings-as-errors
fi

npm --prefix server run typecheck
npm --prefix server test

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  npm --prefix server run test:integration
else
  container="$(docker run -d --rm -e POSTGRES_USER=baton -e POSTGRES_PASSWORD=baton_local -e POSTGRES_DB=baton -p 127.0.0.1::5432 postgres:16-alpine)"
  trap 'docker stop "$container" >/dev/null' EXIT
  ready=0
  for attempt in {1..60}; do
    if docker exec "$container" pg_isready -h 127.0.0.1 -U baton -d baton >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || { echo 'PostgreSQL failed to become ready' >&2; exit 1; }
  port="$(docker port "$container" 5432/tcp)"
  TEST_DATABASE_URL="postgres://baton:baton_local@${port}/baton" npm --prefix server run test:integration
fi
