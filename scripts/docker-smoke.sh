#!/usr/bin/env bash
# Build the image and prove it behaves the way the README says it does. Needs Docker; run from the repository root.
#   scripts/docker-smoke.sh [image-tag]
set -euo pipefail

IMAGE="${1:-finops-dashboard:smoke}"
NAME="finops-smoke-$$"
TOKEN="smoke-test-token-0123456789abcdef"
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
VOL="$(mktemp -d)"
chmod 777 "$VOL" # the container's unprivileged user must be able to write here, whatever the host user is
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$VOL"; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }
ok() { echo "ok   $*"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

docker build -q -t "$IMAGE" . >/dev/null
ok "image builds"

[ "$(docker run --rm "$IMAGE" --version)" = "$(node -p "require('./package.json').version")" ] || fail "--version does not match package.json"
ok "entrypoint is the finops command (--version)"

if out="$(docker run --rm "$IMAGE" start 2>&1)"; then fail "started without AUTH_TOKEN"; fi
echo "$out" | grep -q "refusing to listen on 0.0.0.0 without AUTH_TOKEN" || fail "no clear refusal without AUTH_TOKEN: $out"
ok "refuses to start without AUTH_TOKEN (no insecure default)"

# same port on both sides: the Host header (127.0.0.1:PORT) must be one the server serves
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" -e "PORT=$PORT" -e "AUTH_TOKEN=$TOKEN" -e SEED_DAYS=1 -e SEED_VOLUME=0.1 -v "$VOL:/data" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do [ "$(code "http://127.0.0.1:$PORT/healthz")" = 200 ] && break; sleep 0.5; done
[ "$(code "http://127.0.0.1:$PORT/healthz")" = 200 ] || fail "/healthz did not answer 200"
ok "serves /healthz"
[ "$(code "http://127.0.0.1:$PORT/d/finops/api/summary")" = 401 ] || fail "API answered without a token"
ok "API without a token: 401"
[ "$(code -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/d/finops/api/summary")" = 200 ] || fail "Bearer token refused"
ok "API with the Bearer token: 200"
JAR="$VOL/cookies.txt"
[ "$(code -c "$JAR" -b "$JAR" -L "http://127.0.0.1:$PORT/?token=$TOKEN")" = 200 ] || fail "the /?token= login flow did not end in the page"
ok "browser login flow (/?token= -> cookie -> page): 200"
[ "$(code -H "Host: evil.example" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/d/finops/api/summary")" = 403 ] || fail "a foreign Host header was served"
ok "a foreign Host header is refused (403)"
[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "the container runs as root"
ok "runs as an unprivileged user (uid $(docker exec "$NAME" id -u))"
[ -f "$VOL/finops.db" ] || fail "no database in the mounted volume"
ok "data lands in the mounted volume (/data)"
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "the HEALTHCHECK never reported healthy"
ok "the HEALTHCHECK reports healthy"
echo "docker smoke test passed"
