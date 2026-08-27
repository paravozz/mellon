#!/bin/sh
# Mellon watcher: long-polls the broker's /wait endpoint and exits the moment a
# message arrives for this agent. Run it as a harness background task — its exit
# notification is what re-invokes the agent instantly, even in an idle session.
# The agent re-arms it after every exit.
#
# One watcher per agent per machine (pid lockfile). SessionEnd kills it via
# presence.sh down so a closed session's watcher can't swallow notifications.
# Always exits 0; the final stdout line says what to do next.

[ -n "$MELLON_URL" ] && [ -n "$MELLON_TOKEN" ] && [ -n "$MELLON_AGENT_ID" ] || {
  echo "mellon-watch: not configured (MELLON_URL/TOKEN/AGENT_ID missing)"
  exit 0
}
command -v curl >/dev/null 2>&1 || { echo "mellon-watch: curl not found"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "mellon-watch: python3 not found"; exit 0; }

WAIT_SECS="${MELLON_WAIT_SECS:-50}"
CYCLES="${MELLON_WATCH_CYCLES:-25}"
LOCKDIR="${TMPDIR:-/tmp}/mellon-watch-${MELLON_AGENT_ID}.lock"

# mkdir is atomic: exactly one watcher per agent per machine, no races.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  PID="$(cat "$LOCKDIR/pid" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "mellon-watch: already armed (pid $PID) — do not arm another"
    exit 0
  fi
  # stale lock from a watcher that died without cleanup
  rm -rf "$LOCKDIR"
  mkdir "$LOCKDIR" 2>/dev/null || { echo "mellon-watch: lock contention — re-arm once more"; exit 0; }
fi
echo $$ > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT

i=0
while [ "$i" -lt "$CYCLES" ]; do
  i=$((i + 1))
  RESP="$(curl -fsS --max-time $((WAIT_SECS + 10)) \
    "$MELLON_URL/wait?agent_id=$MELLON_AGENT_ID&timeout=$WAIT_SECS" \
    -H "Authorization: Bearer $MELLON_TOKEN" 2>/dev/null)" || { sleep 5; continue; }
  SUMMARY="$(MELLON_INBOX_JSON="$RESP" python3 - <<'PY' 2>/dev/null
import json, os
try:
    msgs = json.loads(os.environ.get("MELLON_INBOX_JSON") or "{}").get("messages", [])
except Exception:
    msgs = []
if msgs:
    parts = [f'{m["from_agent"]}: "{m["body"][:200]}"' for m in msgs[:3]]
    more = f" (+{len(msgs) - 3} more)" if len(msgs) > 3 else ""
    print(f"{len(msgs)} unread — {' | '.join(parts)}{more}")
PY
)"
  if [ -n "$SUMMARY" ]; then
    echo "mellon-watch: $SUMMARY. Show the question(s) verbatim to the user. Mid-task: ask whether to answer now or continue. Idle: answer via mellon check_inbox from this repo's real code. Then re-arm the watcher."
    exit 0
  fi
done
echo "mellon-watch: quiet for ~$((CYCLES * WAIT_SECS / 60))m — re-arm the watcher (nothing else to do)."
exit 0
