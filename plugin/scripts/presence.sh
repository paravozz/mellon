#!/bin/sh
# Mellon presence hook: up | beat | down | stopcheck
#
#   up        — SessionStart: register + inject standing instructions into context (stdout)
#   beat      — UserPromptSubmit: throttled heartbeat + session-scoped inbox peek
#   stopcheck — Stop: if questions for THIS session wait when the turn ends, block the
#               stop and tell the agent to handle them (answer if idle, ask if mid-task)
#   down      — SessionEnd: end this session on the bridge + stop this session's watcher
#
# Pure POSIX shell + curl. No Python, no Node — assume the user's machine has
# nothing beyond what Claude Code itself needs.
#
# Config (env, via the "env" block of ~/.claude/settings.json or a project's
# .claude/settings.json — project wins, which is how one machine talks to
# different brokers per directory):
#   MELLON_URL       broker base URL, no trailing slash
#   MELLON_TOKEN     shared bearer token
#   MELLON_AGENT_ID  this agent's id, e.g. "alice-frontend"

MODE="${1:-beat}"
STDIN_JSON="$(cat 2>/dev/null | tr -d '\n\r' || true)"

if [ -z "$MELLON_URL" ] || [ -z "$MELLON_TOKEN" ] || [ -z "$MELLON_AGENT_ID" ]; then
  if [ "$MODE" = "up" ]; then
    echo "mellon: plugin installed but not configured — set MELLON_URL, MELLON_TOKEN, MELLON_AGENT_ID (see README)."
  fi
  exit 0
fi

command -v curl >/dev/null 2>&1 || exit 0

# The hook payload carries the Claude Code session id — that is our session key.
SESSION_KEY="$(printf '%s' "$STDIN_JSON" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | tr -d '"\\')"
[ -n "$SESSION_KEY" ] || SESSION_KEY="-"

# Lock name must match watch.sh: agent + broker + session.
URLHASH="$(printf '%s' "$MELLON_URL" | cksum 2>/dev/null | cut -d' ' -f1)"
LOCKDIR="${TMPDIR:-/tmp}/mellon-watch-${MELLON_AGENT_ID}-${URLHASH}-$(printf '%.8s' "$SESSION_KEY").lock"

build_payload() {
  REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  SESSION="$(printf '%s' "$REPO${BRANCH:+ @ $BRANCH}" | tr -d '"\\')"
  printf '{"agent_id":"%s","session":"%s","session_key":"%s"}' "$MELLON_AGENT_ID" "$SESSION" "$SESSION_KEY"
}

post() {
  curl -fsS --max-time 3 -X POST "$MELLON_URL/$1" \
    -H "Authorization: Bearer $MELLON_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" >/dev/null 2>&1
}

# Peek at unread messages routed to THIS session, WITHOUT marking them read.
peek_inbox() {
  curl -fsS --max-time 2 "$MELLON_URL/inbox?agent_id=$MELLON_AGENT_ID&ack=0&session_key=$SESSION_KEY" \
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
Your mellon session key is: ${SESSION_KEY} — pass it as the \`session\` argument to the mellon ask, reply, check_inbox, and set_focus tools, so messages route to the right session.
- ON YOUR FIRST TURN: arm the watcher — run MELLON_SESSION="${SESSION_KEY}" sh "${SCRIPT_DIR}/watch.sh" as a background task (run_in_background, generous timeout). It long-polls the bridge and exits the moment a question for this session arrives, or after ~60 min of quiet. Whenever it exits — for any reason — do what its output says, then immediately re-arm it the same way. It refuses to double-arm, so re-arming is always safe.
- Incoming questions (watcher notifications, <mellon-inbox> notes, end-of-turn nudges): ALWAYS show the user the question verbatim — who asked, what they asked — never process the mailbox silently. If you are mid-task with the user, do not derail: show the question briefly and ask whether to answer now or continue. If nothing is in progress, answer immediately via mellon check_inbox from THIS repo's actual code, citing file paths and endpoints, then show the user what you replied. Never answer from assumption. If a question still isn't for this session's repo, reply saying which agent/session could answer, or tell the user.
- When you start working on a distinct task, and whenever your focus meaningfully changes, call mellon set_focus with a 1-3 sentence free-text summary (ticket ids, repo, branch, progress). Each session has its own focus.
- When the user's question depends on another team's code, API, or decisions, call mellon agents to see who is reachable — each agent lists its live sessions with repo and focus. Ask with mellon ask, and when one of their sessions clearly matches the topic, pass session_hint (a short substring of that session's repo or focus) so the right session answers.
- If the mellon card is missing or still a stub, write a real card once you understand what this agent covers — the file is .claude/mellon-card.json in the project if that directory exists, else ~/.claude/mellon-card.json: {"owner": "<name>", "description": "<2-3 sentences: which repos/areas this agent knows, what teammates should ask it>"} — then call mellon set_card with the same owner and description (hooks do not sync the card). Broaden it over time; never narrow it to today's work (that's what focus is for).
</mellon>
EOF
    ;;

  beat)
    # Heartbeat at most once a minute; inbox peek on every prompt.
    STAMP="${TMPDIR:-/tmp}/mellon-beat-${MELLON_AGENT_ID}-$(printf '%.8s' "$SESSION_KEY")"
    if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1 2>/dev/null)" ]; then
      touch "$STAMP" 2>/dev/null || true
      ( post heartbeat "$(build_payload)" || true ) &
    fi
    INBOX="$(peek_inbox || true)"
    has_mail "$INBOX" || exit 0
    N="$(mail_count "$INBOX")"
    FROM="$(mail_senders "$INBOX")"
    echo "<mellon-inbox>${N} unread message(s) for this session from ${FROM:-teammate agents} on the Mellon bridge. Show the question(s) verbatim to the user. Mid-task: briefly ask whether to answer now or continue. Idle: answer now via mellon check_inbox (pass your session key) from the actual code of this repo.</mellon-inbox>"
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
    printf '{"decision":"block","reason":"Mellon: %s unread question(s) for this session from %s. Show the question(s) verbatim to the user. If you and the user are mid-task or mid-conversation, do NOT derail: end by briefly telling the user a question is waiting and ask whether to answer it now. If nothing is in progress, call the mellon check_inbox tool now (pass your session key), answer from the actual code of this repo with file/endpoint citations (reply via mellon reply), and show the user what you replied."}\n' "$N" "${FROM:-teammate agents}"
    ;;

  down)
    # Stop this session's watcher and end the session on the bridge.
    if [ -d "$LOCKDIR" ]; then
      kill "$(cat "$LOCKDIR/pid" 2>/dev/null)" 2>/dev/null || true
      rm -rf "$LOCKDIR"
    fi
    post deregister "$(build_payload)" || true
    ;;
esac

exit 0
