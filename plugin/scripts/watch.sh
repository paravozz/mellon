#!/bin/sh
# Mellon watcher: long-polls the broker's /wait endpoint and exits the moment a
# message arrives for this agent. Run it as a harness background task — its exit
# notification is what re-invokes the agent instantly, even in an idle session.
# Each arm lasts ~60 min of quiet (or until a message); the agent re-arms it on
# every exit.
#
# Pure POSIX shell + curl; mail detection is a substring check, so it works on
# machines with no Python or Node at all.
#
# One watcher per agent per machine (atomic mkdir lock). SessionEnd kills it via
# presence.sh down so a closed session's watcher can't swallow notifications.
# Always exits 0; the final stdout line says what to do next.

[ -n "$MELLON_URL" ] && [ -n "$MELLON_TOKEN" ] && [ -n "$MELLON_AGENT_ID" ] || {
  echo "mellon-watch: not configured (MELLON_URL/TOKEN/AGENT_ID missing)"
  exit 0
}
command -v curl >/dev/null 2>&1 || { echo "mellon-watch: curl not found"; exit 0; }

WAIT_SECS="${MELLON_WAIT_SECS:-50}"
CYCLES="${MELLON_WATCH_CYCLES:-72}" # 72 x 50s ≈ 60 min; 0 = run for the whole session
LOCKDIR="${TMPDIR:-/tmp}/mellon-watch-${MELLON_AGENT_ID}.lock"

# Orphan guard: if the session that armed us dies without SessionEnd (crash,
# closed terminal), our parent goes away — exit so we release the lock instead
# of holding it forever. This is what makes an unbounded lifetime safe.
PARENT=$PPID

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
while [ "$CYCLES" -eq 0 ] || [ "$i" -lt "$CYCLES" ]; do
  i=$((i + 1))
  kill -0 "$PARENT" 2>/dev/null || { echo "mellon-watch: parent session gone — exiting"; exit 0; }
  RESP="$(curl -fsS --max-time $((WAIT_SECS + 10)) \
    "$MELLON_URL/wait?agent_id=$MELLON_AGENT_ID&timeout=$WAIT_SECS" \
    -H "Authorization: Bearer $MELLON_TOKEN" 2>/dev/null)" || { sleep 5; continue; }
  case "$RESP" in
    *'"thread_id"'*)
      N="$(printf '%s' "$RESP" | grep -o '"thread_id"' | wc -l | tr -d '[:space:]')"
      FROM="$(printf '%s' "$RESP" | tr '{,' '\n\n' \
        | sed -n 's/.*"from_agent" *: *"\([^"]*\)".*/\1/p' \
        | sort -u | tr -d '"\\' | tr '\n' '~' | sed 's/~$//; s/~/, /g')"
      echo "mellon-watch: ${N} unread message(s) from ${FROM:-teammate agents}. Show the question(s) verbatim to the user. Mid-task: ask whether to answer now or continue. Idle: answer via mellon check_inbox from the actual code of this repo. Then re-arm the watcher."
      exit 0
      ;;
  esac
done
echo "mellon-watch: quiet for ~$((CYCLES * WAIT_SECS / 60))m — re-arm the watcher (nothing else to do)."
exit 0
