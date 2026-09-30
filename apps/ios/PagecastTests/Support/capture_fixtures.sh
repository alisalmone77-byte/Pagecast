#!/usr/bin/env bash
# Re-capture the iOS test fixtures from a running Pagecast server.
#
#   npm run dev:api          # in one terminal
#   ./capture_fixtures.sh    # in another
#
# Pass a base URL and a document title fragment to capture a different document.
set -euo pipefail

BASE="${1:-http://localhost:8787}"
MATCH="${2:-}"
VOICE="${PAGECAST_VOICE:-local-clara}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Fixtures"
mkdir -p "$OUT"

id=$(curl -fsS "$BASE/api/documents" | python3 -c "
import sys, json
docs = json.load(sys.stdin)['documents']
match = '''$MATCH'''
if match:
    docs = [d for d in docs if match.lower() in d['title'].lower()]
if not docs:
    raise SystemExit('no matching document; add one first')
print(docs[0]['id'])
")

echo "capturing document $id (voice $VOICE)"
curl -fsS "$BASE/api/documents/$id"                          | python3 -m json.tool > "$OUT/document.json"
curl -fsS "$BASE/api/documents"                              | python3 -m json.tool > "$OUT/library.json"
curl -fsS "$BASE/api/voices"                                 | python3 -m json.tool > "$OUT/voices.json"
curl -fsS "$BASE/api/sync/state/$id"                         | python3 -m json.tool > "$OUT/state.json"
curl -fsS "$BASE/api/documents/$id/timeline?voiceId=$VOICE" \
  | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['timeline'], indent=1))" > "$OUT/timeline.json"

echo "wrote fixtures to $OUT"
python3 "$(dirname "${BASH_SOURCE[0]}")/verify_fixtures.py"
