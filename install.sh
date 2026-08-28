#!/bin/sh
# Mellon installer — pure POSIX shell; needs only curl (and the claude CLI for
# the plugin step). No Node, no Python required.
#
#   curl -fsSL https://raw.githubusercontent.com/paravozz/mellon/main/install.sh | sh -s -- \
#     --server <broker url> --token <shared token> [--agent-id <id>] \
#     [--project <dir>] [--owner <name>] [--description <text>] \
#     [--marketplace <ref>] [--no-plugin]
#
# --project scopes the bridge to one directory: config goes into
# <dir>/.claude/settings.json, so only sessions started under that directory
# use this broker. Run once per team folder to keep separate bridges
# (e.g. ~/Work/bookmap on the bookmap broker, ~/Work/GLEB on another).

say() { printf '%s\n' "$*"; }
die() { printf 'mellon: %s\n' "$*" >&2; exit 1; }

SERVER="" TOKEN="" AGENT_ID="" OWNER="" DESC="" OWNER_ARG="" DESC_ARG=""
MARKETPLACE="paravozz/mellon" NO_PLUGIN="" PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server | --url) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --agent-id | --agent_id) AGENT_ID="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --owner) OWNER="$2"; OWNER_ARG=1; shift 2 ;;
    --description) DESC="$2"; DESC_ARG=1; shift 2 ;;
    --marketplace) MARKETPLACE="$2"; shift 2 ;;
    --no-plugin) NO_PLUGIN=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || die "usage: install.sh --server <broker url> --token <shared token> [--agent-id <id>] [--project <dir>] — get the URL and token from whoever deployed your team broker"
SERVER="$(printf '%s' "$SERVER" | sed 's:/*$::')"
command -v curl >/dev/null 2>&1 || die "curl is required"

USER_NAME="$(id -un 2>/dev/null || echo user)"
HOST="$(hostname 2>/dev/null | cut -d. -f1)"
[ -n "$AGENT_ID" ] || AGENT_ID="$USER_NAME-$HOST"
AGENT_ID="$(printf '%s' "$AGENT_ID" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//')"
[ -n "$OWNER" ] || OWNER="$USER_NAME"
[ -n "$DESC" ] || DESC="$OWNER's agent on $HOST. (Stub card - the agent will replace this once it knows what it covers.)"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }

# --- 1. Verify the broker answers with this token before writing anything ----
say "Checking broker $SERVER ..."
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $TOKEN" "$SERVER/agents" || echo 000)"
case "$CODE" in
  200) say "Broker ok." ;;
  401) die "broker rejected the token (401) — check --token" ;;
  000) die "cannot reach $SERVER — check --server" ;;
  *)   die "broker answered HTTP $CODE — is that a Mellon broker URL?" ;;
esac

# --- 2. Config into settings.json (global, or the project's) ----------------
if [ -n "$PROJECT" ]; then
  [ -d "$PROJECT" ] || die "project directory not found: $PROJECT"
  CLAUDE_DIR="$PROJECT/.claude"
  say "Scoping this bridge to $PROJECT (sessions started there use it)"
else
  CLAUDE_DIR="$HOME/.claude"
fi
mkdir -p "$CLAUDE_DIR"
SETTINGS="$CLAUDE_DIR/settings.json"

# Merging JSON needs a JSON tool. Resolve one by EXECUTING it (a broken PATH
# alias, like the Windows Store python3 stub, passes `command -v` but not this).
JSON_TOOL=""
if node -e "0" >/dev/null 2>&1; then JSON_TOOL="node"
elif python3 -c "0" >/dev/null 2>&1; then JSON_TOOL="python3"
elif python -c "0" >/dev/null 2>&1; then JSON_TOOL="python"
fi

if [ -n "$JSON_TOOL" ]; then
  M_URL="$SERVER" M_TOKEN="$TOKEN" M_ID="$AGENT_ID" M_SETTINGS="$SETTINGS"
  export M_URL M_TOKEN M_ID M_SETTINGS
  if [ "$JSON_TOOL" = "node" ]; then
    node -e '
const fs=require("fs"),p=process.env.M_SETTINGS;let s={};
if(fs.existsSync(p)){try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){process.exit(2)}}
s.env=Object.assign({},s.env,{MELLON_URL:process.env.M_URL,MELLON_TOKEN:process.env.M_TOKEN,MELLON_AGENT_ID:process.env.M_ID});
fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");' \
      || die "$SETTINGS exists but is not valid JSON — fix it and re-run"
  else
    "$JSON_TOOL" -c '
import json, os, sys
p = os.environ["M_SETTINGS"]; s = {}
if os.path.exists(p):
    try:
        s = json.load(open(p))
    except Exception:
        sys.exit(2)
s.setdefault("env", {})
s["env"].update({"MELLON_URL": os.environ["M_URL"], "MELLON_TOKEN": os.environ["M_TOKEN"], "MELLON_AGENT_ID": os.environ["M_ID"]})
open(p, "w").write(json.dumps(s, indent=2) + "\n")' \
      || die "$SETTINGS exists but is not valid JSON — fix it and re-run"
  fi
  say "Wrote $SETTINGS (env.MELLON_URL / MELLON_TOKEN / MELLON_AGENT_ID)"
elif [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<EOF
{
  "env": {
    "MELLON_URL": "$SERVER",
    "MELLON_TOKEN": "$TOKEN",
    "MELLON_AGENT_ID": "$AGENT_ID"
  }
}
EOF
  say "Wrote $SETTINGS"
else
  say ""
  say "!! $SETTINGS already exists and no JSON tool is available to merge safely."
  say "!! Add these three entries to the \"env\" object in it yourself:"
  say '     "MELLON_URL": "'"$SERVER"'",'
  say '     "MELLON_TOKEN": "'"$TOKEN"'",'
  say '     "MELLON_AGENT_ID": "'"$AGENT_ID"'"'
fi

# --- 3. Agent card (kept if present, unless overridden) ----------------------
CARD="$CLAUDE_DIR/mellon-card.json"
if [ ! -f "$CARD" ] || [ -n "$OWNER_ARG$DESC_ARG" ]; then
  printf '{\n  "owner": "%s",\n  "description": "%s"\n}\n' \
    "$(json_escape "$OWNER")" "$(json_escape "$DESC")" > "$CARD"
  say "Wrote $CARD"
else
  say "Kept existing $CARD"
fi

# --- 4. Register on the bridge so teammates see you immediately --------------
# Push owner/description only when explicitly given: a re-run must never
# overwrite a richer agent-authored card on the broker with generated defaults.
REG_OWNER=""; REG_DESC=""
[ -n "$OWNER_ARG" ] && REG_OWNER="$OWNER"
[ -n "$DESC_ARG" ] && REG_DESC="$DESC"
if curl -fsS --max-time 10 -X POST "$SERVER/register" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"owner\":\"$(json_escape "$REG_OWNER")\",\"description\":\"$(json_escape "$REG_DESC")\",\"session\":\"\"}" \
  >/dev/null 2>&1; then
  say "Registered \"$AGENT_ID\" on the bridge"
else
  say "Could not pre-register (will happen on first session start instead)"
fi

# --- 5. Install the Claude Code plugin ---------------------------------------
if [ -z "$NO_PLUGIN" ]; then
  if command -v claude >/dev/null 2>&1; then
    claude plugin marketplace add "$MARKETPLACE" >/dev/null 2>&1 || true
    if claude plugin install mellon@mellon >/dev/null 2>&1; then
      # `install` is a no-op when already installed — update so re-runs pick up the latest.
      claude plugin update mellon >/dev/null 2>&1 || true
      say "Installed the mellon plugin (latest version)"
    else
      say "Plugin step needs to run inside Claude Code: /plugin marketplace add $MARKETPLACE  then  /plugin install mellon@mellon"
    fi
  else
    say "claude CLI not found — run inside Claude Code: /plugin marketplace add $MARKETPLACE  then  /plugin install mellon@mellon"
  fi
fi

say ""
say "Done. Agent id: $AGENT_ID"
say "Restart Claude Code to come online. Try /mellon:who, /mellon:ask, /mellon:inbox."
