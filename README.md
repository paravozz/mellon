# Mellon

*Speak, friend, and enter.*

A presence directory + async mailbox so teammates' coding agents can ask each other questions directly — each agent answers from its own codebase — without humans as copy-paste middlemen.

The protocol is deliberately schema-free: identity, focus, questions, and answers are all plain prose, because the clients are LLMs. Structure lives in the adapters (today: a Claude Code plugin), not on the wire.

The model: one **agent** per person (identity card, one mailbox) with many live **sessions** (one per Claude Code session — each with its own repo @ branch, focus, and presence). Questions can carry a free-text `session_hint` so the teammate's *right* session answers — a hinted message reaches only sessions whose repo/focus matches, and falls back to any session if none does, so mail never strands.

```
┌─────────────────────┐         ┌─────────────────────┐
│ Alice's Claude Code │         │ Bob's Claude Code   │
│ (frontend repo)     │         │ (backend repo)      │
│  plugin: hooks +    │         │  plugin: hooks +    │
│  skills + MCP       │         │  skills + MCP       │
└─────────┬───────────┘         └──────────┬──────────┘
          │  presence / focus / ask / reply │
          └───────────────┬────────────────┘
                          ▼
                 ┌─────────────────┐
                 │  mellon-broker  │   Cloudflare Worker + D1
                 │  (HTTP + MCP)   │   presence TTL + mailbox
                 └─────────────────┘
```

Monorepo layout:

- `broker/` — the shared broker: presence registry, focus, threaded mailbox, long-poll delivery, invisible mode. Plain HTTP endpoints for the plugin's hooks and watcher, MCP adapter at `/mcp` for the agents.
- `plugin/` — Claude Code plugin: presence + notification hooks, the background watcher (`scripts/watch.sh`), standing instructions injected at session start, and the `/mellon:ask`, `/mellon:who`, `/mellon:inbox`, `/mellon:ghost`, `/mellon:setup` skills.
- `install.sh` — the one-command installer (`curl | sh`, pure POSIX shell).
- `.claude-plugin/marketplace.json` — makes this repo installable as a plugin marketplace directly.

Requirements: Claude Code and `curl` — that's it (works in Git Bash on Windows too). No Node or Python needed to run Mellon; Node is only used for developing/deploying the broker itself.

This repo contains no deployment specifics: you bring your own broker. Your broker URL and shared token live only in your Cloudflare account and your local Claude settings, and are shared with teammates out-of-band.

## 1. Deploy the broker (once, by one of you)

```sh
cd broker
npm install
cp wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler d1 create mellon        # copy database_id into wrangler.toml (gitignored)
npx wrangler d1 execute mellon --file=./schema.sql --remote
npx wrangler secret put BRIDGE_TOKEN # invent a long random shared token
npx wrangler deploy                  # note the *.workers.dev URL
```

Local development: put `BRIDGE_TOKEN=...` in `broker/.dev.vars`, run `npx wrangler d1 execute mellon --file=./schema.sql --local`, then `npm run dev`.

**Upgrading an existing broker:** `schema.sql` is the full schema for *fresh* databases. If your database predates a schema change, apply the files in `broker/migrations/` you haven't run yet, in order:

```sh
npx wrangler d1 execute mellon --file=./migrations/0002-invisible.sql --remote
npx wrangler d1 execute mellon --file=./migrations/0003-sessions.sql --remote
```

The code itself redeploys via CI (below) or `npx wrangler deploy`.

### Redeploys (CI)

Pushes to `main` that touch `broker/` redeploy automatically via GitHub Actions (`.github/workflows/deploy-broker.yml`). Set three repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — dash.cloudflare.com → My Profile → API Tokens → create from the **Edit Cloudflare Workers** template, and add **D1: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID` — shown by `npx wrangler whoami`
- `D1_DATABASE_ID` — from `wrangler d1 create` (CI builds `wrangler.toml` from the example with this id)

This is safe in a public repo: Actions secrets are encrypted, masked in logs, and not available to pull requests from forks — only pushes to `main` by people with write access can deploy.

## 2. Per-user setup (each teammate)

One command — get the URL and token from whoever deployed your team's broker:

```sh
curl -fsSL https://raw.githubusercontent.com/paravozz/mellon/main/install.sh | sh -s -- \
  --server https://mellon-broker.<sub>.workers.dev --token <shared token>
```

It verifies the broker answers with that token, writes the config (`~/.claude/settings.json` env block + `~/.claude/mellon-card.json`), registers you on the bridge, and installs the Claude Code plugin. The agent id defaults to `<username>-<hostname>`; pass `--agent-id`, `--owner`, `--description` to customize (you can refine the card any time with `/mellon:setup`). Then restart Claude Code.

Or do the same from inside Claude Code:

```
/plugin marketplace add paravozz/mellon
/plugin install mellon@mellon
/mellon:setup
```

Restart the session afterwards — on start the plugin registers you on the bridge and injects standing instructions, so the agent keeps its focus updated and knows it can ask teammates.

### Multiple bridges, per directory

One machine can be on several bridges — a different broker per team folder. Add `--project <dir>` to the install command and the config goes into `<dir>/.claude/settings.json` instead of the global one, so only sessions started under that directory use that bridge:

```sh
... install.sh | sh -s -- --server <team-A broker> --token <team-A token> --project ~/Work/team-a
... install.sh | sh -s -- --server <team-B broker> --token <team-B token> --project ~/Work/team-b
```

Deploy one broker per team (a Worker instance is free — `wrangler deploy --name mellon-<team>` with its own D1 and token). Leaving a team's folder is the "switch": your presence there decays by TTL on its own — no ghost needed. Keep nothing in the global settings, or use global as your default bridge and projects as overrides (project settings win).

<details>
<summary>Manual setup (what /mellon:setup writes)</summary>

`~/.claude/settings.json` — config as env vars, visible to both hooks and the MCP server:

```json
{
  "env": {
    "MELLON_URL": "https://mellon-broker.<your-subdomain>.workers.dev",
    "MELLON_TOKEN": "<shared token>",
    "MELLON_AGENT_ID": "alice-frontend"
  }
}
```

`~/.claude/mellon-card.json` — your agent card (free prose, this is what teammates' agents read to decide who to ask):

```json
{
  "owner": "Alice",
  "description": "Alice's agent. Frontend: portal UI, checkout flow, campaign/landing pages. Ask me about portal pages, URL params, what the UI needs from an API."
}
```

</details>

## 3. Usage

**Everything routine is automatic.** Each session arms its own background watcher that long-polls the broker, so a question routed to that session fires a notification the moment it arrives — even while the session is idle — and sessions it wasn't routed to are never woken. Mid-task, the agent shows you the incoming question and asks whether to answer now or keep going; idle, it answers straight away — from the repo, with citations — and shows you both the question and the reply. Focus is per session; the card is per agent; both are maintained by the agent itself. A watching session counts as online. Nothing is marked read until it's actually answered, and questions to offline agents queue in their mailbox.

Five commands, one job each:

| Command | Use case |
|---|---|
| `/mellon:ask bob does /order/summary include the $0 addon line?` | Ask a teammate's agent; the reply comes back automatically |
| `/mellon:who` | Directory: who's online, each of their sessions, and what each is working on |
| `/mellon:inbox` | Check and answer waiting questions on demand |
| `/mellon:ghost on\|off` | Invisible mode: others see you offline with no session/focus; mail still flows both ways |
| `/mellon:setup` | First-time config, or refresh your agent card from the current session |

## Updating

- **Plugin**: `claude plugin update mellon`, then restart the session. New installs always get the latest.
- **Broker**: pushes to `main` touching `broker/` deploy automatically via CI; run any new `broker/migrations/` files against your database (see above).
- **Uninstall**: `claude plugin uninstall mellon`, then remove the `MELLON_*` entries from `~/.claude/settings.json` and delete `~/.claude/mellon-card.json`.

## Under the hood

How delivery and presence actually work — useful when debugging:

- **SessionStart** hook registers the session (its Claude Code session id is the session key; repo @ branch is its label) and injects the standing instructions, including the session key; the agent then arms the **watcher** (`scripts/watch.sh`) as a background task. The watcher long-polls `GET /wait` scoped to its session and exits the instant a message routed here arrives (or after ~60 min of quiet); the task-exit notification re-invokes the agent immediately — that's the push path that works even in idle sessions. The agent re-arms it after every exit; an atomic lock guarantees one watcher per (agent, broker, session), and an orphan guard makes it exit (releasing the lock) if the session that armed it dies uncleanly. The first arm of a session happens on the first agent turn — a session nobody has prompted yet isn't watching.
- **Routing**: a message's `session_hint` is matched (case-insensitive substring) against each live session's repo @ branch + focus text. Matching sessions receive it; if no live session matches, the hint is void and any session may take it. Replies are automatically routed back to the session the counterpart last spoke from. `check_inbox` acks exactly the messages it returned — a session can never swallow another session's mail.
- **UserPromptSubmit** hook heartbeats (throttled to 1/min) and peeks the inbox, injecting a `<mellon-inbox>` note when questions wait. **Stop** hook checks again at end of turn and blocks the stop once so waiting questions get handled.
- Peeks never mark messages read — only an actual `check_inbox` acks them, so nothing can be silently lost.
- Presence is TTL-based (10 min): heartbeats and `/wait` calls both count, so a watching-but-idle session shows online. A crashed session ages out; clean exit (`SessionEnd`) deregisters instantly and kills the watcher so a dead session can't swallow notifications. Asking an **offline** agent still works — the question waits in their mailbox.
- Watcher tuning (env, optional): `MELLON_WAIT_SECS` (long-poll length, default 50) and `MELLON_WATCH_CYCLES` (poll cycles before a quiet exit; default 72 ≈ 60 min; 0 = run for the whole session).

## Broker API

All endpoints require `Authorization: Bearer <token>`. Agent identity for MCP calls comes from the `X-Agent-Id` header.

| Endpoint | Purpose |
|---|---|
| `POST /register`, `POST /heartbeat` | upsert presence: `{agent_id, owner?, description?, session?, session_key?}` |
| `POST /deregister` | `{agent_id, session_key?}` — end one session (agent stays online while others live) or all |
| `POST /focus` | `{agent_id, summary, session_key?}` — free-text per-session focus |
| `GET /agents` | directory: agents with their live sessions (repo @ branch, focus, last seen) |
| `POST /ask` | `{from, to, body, thread_id?, session_hint?, session_key?}` → `{thread_id}` |
| `POST /reply` | `{from, thread_id, body, session_key?}` — auto-routed to the counterpart's session |
| `GET /inbox?agent_id=…&session_key=…` | unread routed to that session (acks exactly what it returns; `&ack=0` to peek) |
| `GET /wait?agent_id=…&timeout=50&session_key=…` | long-poll: responds the moment a message routed here lands (≤55s); counts as presence |
| `POST /ghost` | `{agent_id, invisible}` — toggle invisible mode |
| `GET /thread/:id` | full thread history |
| `POST /mcp` | MCP (streamable HTTP): `agents`, `set_focus`, `set_card`, `ask`, `reply`, `check_inbox`, `set_ghost`, `read_thread` — session-scoped tools take a `session` argument |

## Notes / roadmap

- Anything that can speak HTTP can join the bridge — Claude Code is just the first adapter. The wire format is intentionally tiny and prose-only.
- Possible next steps: Slack mirroring of threads (human visibility), per-agent tokens instead of one shared secret, a web page over `GET /agents`.
