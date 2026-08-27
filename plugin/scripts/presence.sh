#!/bin/sh
# Mellon presence hook: up | beat | down | stopcheck
#
#   up        — SessionStart: register + inject standing instructions into context (stdout)
#   beat      — UserPromptSubmit: throttled heartbeat + inbox peek; unread questions are
#               injected into context so the agent can surface them mid-conversation
#   stopcheck — Stop: if unread questions are waiting when the turn ends, block the stop
#               and tell the agent to handle them (answer if idle, ask the user if mid-task)
#   down      — SessionEnd: courtesy deregister (crash-safety comes from the TTL, not this)
#
# Config (env, e.g. via ~/.claude/settings.json "env" block):
#   MELLON_URL       broker base URL, no trailing slash
#   MELLON_TOKEN     shared bearer token
#   MELLON_AGENT_ID  this agent's id, e.g. "alice-frontend"
# Identity card (prose): ~/.claude/mellon-card.json  {"owner": "...", "description": "..."}

MODE="${1:-beat}"
STDIN_JSON="$(cat 2>/dev/null || true)"

if [ -z "$MELLON_URL" ] || [ -z "$MELLON_TOKEN" ] || [ -z "$MELLON_AGENT_ID" ]; then
  if [ "$MODE" = "up" ]; then
    echo "mellon: plugin installed but not configured — set MELLON_URL, MELLON_TOKEN, MELLON_AGENT_ID (see README)."
  fi
  exit 0
fi

command -v python3 >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

build_payload() {
  REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  MELLON_REPO="$REPO" MELLON_BRANCH="$BRANCH" python3 - <<'PY'
import json, os, pathlib

card = {}
try:
    card = json.loads((pathlib.Path.home() / ".claude" / "mellon-card.json").read_text())
except Exception:
    pass

repo = os.environ.get("MELLON_REPO", "")
branch = os.environ.get("MELLON_BRANCH", "")
session = repo + (f" @ {branch}" if branch else "")

print(json.dumps({
    "agent_id": os.environ["MELLON_AGENT_ID"],
    "owner": card.get("owner") or os.environ.get("USER", ""),
    "description": card.get("description", ""),
    "session": session,
}))
PY
}

post() {
  curl -fsS --max-time 3 -X POST "$MELLON_URL/$1" \
    -H "Authorization: Bearer $MELLON_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" >/dev/null 2>&1
}

# Peek at unread messages WITHOUT marking them read (only check_inbox acks).
peek_inbox() {
  curl -fsS --max-time 2 "$MELLON_URL/inbox?agent_id=$MELLON_AGENT_ID&ack=0" \
    -H "Authorization: Bearer $MELLON_TOKEN" 2>/dev/null
}

case "$MODE" in
  up)
    post register "$(build_payload)" || true
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    cat <<EOF
<mellon>
This session is connected to Mellon — a presence directory + mailbox linking you to teammates' agents (MCP server "mellon").
- ON YOUR FIRST TURN: arm the watcher — run sh "${SCRIPT_DIR}/watch.sh" as a background task (run_in_background). It long-polls the bridge and exits the moment a teammate's question arrives (or after ~20 min of quiet). Whenever it exits, do what its output says, then immediately re-arm it the same way. It refuses to double-arm, so re-arming is always safe. This is what makes delivery instant even while the session is idle.
- Incoming questions (watcher notifications, <mellon-inbox> notes, end-of-turn nudges): ALWAYS show the user the question verbatim — who asked, what they asked — never process the mailbox silently. If you are mid-task with the user, do not derail: show the question briefly and ask whether to answer now or continue. If nothing is in progress, answer immediately via mellon check_inbox from THIS repo's actual code, citing file paths and endpoints, then show the user what you replied. Never answer from assumption. If this session's repo is the wrong place to answer, reply saying which agent/repo could, or tell the user.
- When you start working on a distinct task, and whenever your focus meaningfully changes, call the mellon set_focus tool with a 1-3 sentence free-text summary (include ticket ids, repo, branch, and progress where relevant).
- When the user's question depends on another team's code, API, or decisions, call mellon agents to see who is reachable and consider asking them with mellon ask instead of guessing — each teammate's agent answers from its own codebase.
- If ~/.claude/mellon-card.json is missing or still a stub, write a real card once you understand what this agent covers: {"owner": "<name>", "description": "<2-3 sentences: which repos/areas this agent knows, what teammates should ask it>"}. When you learn new areas in later sessions, broaden the description — never narrow it to just today's work (that's what focus is for). It syncs to the bridge on the next heartbeat.
</mellon>
EOF
    ;;

  beat)
    # Heartbeat at most once a minute; inbox peek on every prompt.
    STAMP="${TMPDIR:-/tmp}/mellon-beat-${MELLON_AGENT_ID}"
    if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1 2>/dev/null)" ]; then
      touch "$STAMP" 2>/dev/null || true
      ( post heartbeat "$(build_payload)" || true ) &
    fi
    MELLON_INBOX_JSON="$(peek_inbox || true)" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    msgs = json.loads(os.environ.get("MELLON_INBOX_JSON") or "{}").get("messages", [])
except Exception:
    msgs = []
if msgs:
    parts = [f"{m['from_agent']}: \"{m['body'][:150]}\"" for m in msgs[:3]]
    more = f" (+{len(msgs) - 3} more)" if len(msgs) > 3 else ""
    print(
        f"<mellon-inbox>{len(msgs)} unread on the Mellon bridge — {' | '.join(parts)}{more}. "
        "Show the question(s) verbatim to the user. Mid-task: briefly ask whether to answer now or continue. "
        "Idle: answer now via mellon check_inbox from this repo's real code.</mellon-inbox>"
    )
PY
    ;;

  stopcheck)
    # Never re-block a continuation we caused (loop guard).
    printf '%s' "$STDIN_JSON" | python3 -c '
import json, sys
try:
    active = json.load(sys.stdin).get("stop_hook_active", False)
except Exception:
    active = False
sys.exit(1 if active else 0)
' 2>/dev/null || exit 0
    MELLON_INBOX_JSON="$(peek_inbox || true)" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    msgs = json.loads(os.environ.get("MELLON_INBOX_JSON") or "{}").get("messages", [])
except Exception:
    msgs = []
if msgs:
    parts = [f"{m['from_agent']}: \"{m['body'][:150]}\"" for m in msgs[:3]]
    more = f" (+{len(msgs) - 3} more)" if len(msgs) > 3 else ""
    reason = (
        f"Mellon: {len(msgs)} unread question(s) from teammate agents — {' | '.join(parts)}{more}. "
        "Show the question(s) verbatim to the user. If you and the user are mid-task or mid-conversation, "
        "do NOT derail it: end by briefly telling the user a question is waiting and ask whether to answer "
        "it now. If nothing is in progress, call the mellon check_inbox tool now, answer from this repo's "
        "actual code with file/endpoint citations (reply via mellon reply), and show the user what you "
        "replied. If this repo is unrelated to the question, reply saying which agent/repo could answer, "
        "or tell the user."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
PY
    ;;

  down)
    # Stop this session's watcher so a dead session can't swallow notifications.
    LOCKDIR="${TMPDIR:-/tmp}/mellon-watch-${MELLON_AGENT_ID}.lock"
    if [ -d "$LOCKDIR" ]; then
      kill "$(cat "$LOCKDIR/pid" 2>/dev/null)" 2>/dev/null || true
      rm -rf "$LOCKDIR"
    fi
    post deregister "$(build_payload)" || true
    ;;
esac

exit 0
