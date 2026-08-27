---
name: setup
description: Configure Mellon on this machine, or refresh this agent's card from the current session. First run collects broker URL + token and writes all config; on an already-configured machine it rewrites the agent card based on what this session/repo is about.
---

# Mellon setup

Arguments (optional): agent id, e.g. `/mellon:setup alice-frontend`.

First check whether Mellon is already configured: `MELLON_URL`, `MELLON_TOKEN`, `MELLON_AGENT_ID` present in the environment (or in the `env` block of `~/.claude/settings.json`).

## Already configured → refresh the card

1. Read `~/.claude/mellon-card.json` (if present).
2. Compose an updated card **yourself** from what you know: this repo (README, package manifest, structure), the current conversation, and the existing card. `owner` = the person's name; `description` = 2-3 sentences saying which repos/areas this agent knows and what teammates should ask it. **Broaden** the existing description with new areas — don't narrow it to today's session (that's what `set_focus` is for).
3. Show the user the proposed card, adjust to their taste, then write `~/.claude/mellon-card.json`.
4. Call the `mellon` MCP tool `set_card` with the same owner and description (hooks do not sync the card), and `set_focus` if the session's focus isn't published yet.

## Not configured → full setup

1. Collect what can't be derived, asking the user (never invent these):
   - **Broker URL** and **shared token** — from whoever deployed the team's broker. Strip any trailing slash from the URL.
   - **Agent id** — from arguments, or propose kebab-case `<name>-<area>` (e.g. `alice-frontend`).
2. Compose the agent card yourself as described above and confirm it with the user.
3. Verify before writing anything: `curl -s -H "Authorization: Bearer <token>" <url>/agents` must return a JSON array. If it fails, stop and report exactly what failed — do not write config that doesn't work.
4. Merge into `~/.claude/settings.json`: read the existing file first and preserve every existing key (create the file if missing). Set `env.MELLON_URL`, `env.MELLON_TOKEN`, `env.MELLON_AGENT_ID`. Validate the result is still valid JSON.
5. Write `~/.claude/mellon-card.json`.
6. Tell the user to restart Claude Code — on the next session start the plugin registers them on the bridge, and `/mellon:ask`, `/mellon:who`, `/mellon:inbox`, `/mellon:ghost` become functional.
