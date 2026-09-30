#!/usr/bin/env bash
# Re-capture the iOS test fixtures from a running Pagecast server.
#
#   npm run dev:api                                  # in one terminal
#   PAGECAST_EMAIL=you@example.com \
#   PAGECAST_PASSWORD='your passphrase' \
#     ./capture_fixtures.sh                          # in another
#
# The account is created if it does not exist. A document is added if the
# library is empty, so this works against a fresh server.
set -euo pipefail

BASE="${1:-http://localhost:8787}"
MATCH="${2:-}"
VOICE="${PAGECAST_VOICE:-local-clara}"
EMAIL="${PAGECAST_EMAIL:-fixtures@example.com}"
PASSWORD="${PAGECAST_PASSWORD:-a decent long passphrase}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Fixtures"
mkdir -p "$OUT"

credentials=$(python3 -c "
import json, os
print(json.dumps({'email': os.environ['E'], 'password': os.environ['P']}))
" E="$EMAIL" P="$PASSWORD")

extract() { python3 -c "import sys, json; print(json.load(sys.stdin).get('$1', ''))"; }

# Register, falling back to signing in when the account already exists.
token=$(curl -sS -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "$credentials" | extract token)
if [ -z "$token" ]; then
  token=$(curl -sS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "$credentials" | extract token)
fi
[ -n "$token" ] || { echo "could not authenticate as $EMAIL" >&2; exit 1; }
auth=(-H "authorization: Bearer $token")

id=$(curl -fsS "${auth[@]}" "$BASE/api/documents" | python3 -c "
import sys, json
docs = json.load(sys.stdin)['documents']
match = '''$MATCH'''
if match:
    docs = [d for d in docs if match.lower() in d['title'].lower()]
print(docs[0]['id'] if docs else '')
")

if [ -z "$id" ]; then
  echo "library is empty; adding a sample document"
  id=$(curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' \
    -d '{"title":"Sample","text":"# Heading\n\nA first sentence. A second one follows.\n\nA second paragraph here."}' \
    "$BASE/api/ingest/text" | python3 -c "import sys, json; print(json.load(sys.stdin)['meta']['id'])")
fi

echo "capturing document $id (voice $VOICE)"
curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' -d '{"wait":true}' \
  "$BASE/api/documents/$id/audio" > /dev/null
# A reading state has to exist, or the state fixture captures a 404 body.
curl -fsS -X PUT "${auth[@]}" -H 'content-type: application/json' \
  -d '{"position":{"blockIndex":1,"tokenIndex":0},"speed":1.5,"rev":0,"deviceId":"fixture-device"}' \
  "$BASE/api/sync/state/$id" > /dev/null

curl -fsS "${auth[@]}" "$BASE/api/documents/$id"   | python3 -m json.tool > "$OUT/document.json"
curl -fsS "${auth[@]}" "$BASE/api/documents"       | python3 -m json.tool > "$OUT/library.json"
curl -fsS "${auth[@]}" "$BASE/api/voices"          | python3 -m json.tool > "$OUT/voices.json"
curl -fsS "${auth[@]}" "$BASE/api/folders"         | python3 -m json.tool > "$OUT/folders.json"
curl -fsS "${auth[@]}" "$BASE/api/sync/state/$id"  | python3 -m json.tool > "$OUT/state.json"
curl -fsS "${auth[@]}" "$BASE/api/documents/$id/timeline?voiceId=$VOICE" \
  | python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin)['timeline'], indent=1))" \
  > "$OUT/timeline.json"

echo "wrote fixtures to $OUT"
python3 "$(dirname "${BASH_SOURCE[0]}")/verify_fixtures.py"
