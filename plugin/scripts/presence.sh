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
# Pure POSIX shell + curl. No Python, no Node — assume the user's machine has
# nothing beyond what Claude Code itself needs. Message previews are therefore
# not included in notifications; the agent shows questions verbatim right after
# via check_inbox, so nothing is lost.
#
# Config (env, e.g. via ~/.claude/settings.json "env" block):
#   MELLON_URL       broker base URL, no trailing slash
#   MELLON_TOKEN     shared bearer token
#   MELLON_AGENT_ID  this agent's id, e.g. "alice-frontend"

MODE="${1:-beat}"
STDIN_JSON="$(cat 2>/dev/null || true)"

if [ -z "$MELLON_URL" ] || [ -z "$MELLON_TOKEN" ] || [ -z "$MELLON_AGENT_ID" ]; then
  if [ "$MODE" = "up" ]; then
    echo "mellon: plugin installed but not configured — set MELLON_URL, MELLON_TOKEN, MELLON_AGENT_ID (see README)."
  fi
  exit 0
fi

command -v curl >/dev/null 2>&1 || exit 0

build_payload() {
  REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  SESSION="$(printf '%s' "$REPO${BRANCH:+ @ $BRANCH}" | tr -d '"\\')"
  printf '{"agent_id":"%s","session":"%s"}' "$MELLON_AGENT_ID" "$SESSION"
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

has_mail() {
  case "$1" in *'"thread_id"'*) return 0 ;; esac
  return 1
}

mail_count() {
  printf '%s' "$1" | grep -o '"thread_id"' | wc -l | tr -d '[:space:]'
}

mail_senders() {
  printf '%s' "$1" | tr '{,' '\n\n' \
    | sed -n 's/.*"from_agent" *: *"\([^"]*\)".*/\1/p' \
    | sort -u | tr -d '"\\' | tr '\n' '~' | sed 's/~$//; s/~/, /g'
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
- If ~/.claude/mellon-card.json is missing or still a stub, write a real card once you understand what this agent covers: {"owner": "<name>", "description": "<2-3 sentences: which repos/areas this agent knows, what teammates should ask it>"} — then call the mellon set_card tool with the same owner and description (hooks do not sync the card). In later sessions broaden the description when you learn new areas; never narrow it to just today's work (that's what focus is for).
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
    INBOX="$(peek_inbox || true)"
    has_mail "$INBOX" || exit 0
    N="$(mail_count "$INBOX")"
    FROM="$(mail_senders "$INBOX")"
    echo "<mellon-inbox>${N} unread message(s) from ${FROM:-teammate agents} on the Mellon bridge. Show the question(s) verbatim to the user. Mid-task: briefly ask whether to answer now or continue. Idle: answer now via mellon check_inbox from the actual code of this repo.</mellon-inbox>"
    ;;

  stopcheck)
    # Never re-block a continuation we caused (loop guard).
    case "$STDIN_JSON" in
      *'"stop_hook_active": true'* | *'"stop_hook_active":true'*) exit 0 ;;
    esac
    INBOX="$(peek_inbox || true)"
    has_mail "$INBOX" || exit 0
    N="$(mail_count "$INBOX")"
    FROM="$(mail_senders "$INBOX")"
    printf '{"decision":"block","reason":"Mellon: %s unread question(s) from %s. Show the question(s) verbatim to the user. If you and the user are mid-task or mid-conversation, do NOT derail: end by briefly telling the user a question is waiting and ask whether to answer it now. If nothing is in progress, call the mellon check_inbox tool now, answer from the actual code of this repo with file/endpoint citations (reply via mellon reply), and show the user what you replied. If this repo is unrelated to the question, reply saying which agent/repo could answer, or tell the user."}\n' "$N" "${FROM:-teammate agents}"
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
