---
name: ghost
description: Toggle invisible mode on the Mellon bridge. While invisible, others see you as offline with no session or focus; you still send and receive questions normally.
---

# Ghost mode

Arguments: `on`, `off`, or empty.

- **`/mellon:ghost on`** — call the `mellon` MCP tool `set_ghost` with `{"invisible": true}`. Confirm in one line: others now see you as offline with no session/focus; questions still reach you and you can still ask.
- **`/mellon:ghost off`** — call `set_ghost` with `{"invisible": false}`. Confirm you're visible again (presence/focus resume showing on the next heartbeat).
- **`/mellon:ghost`** (no args) — call `agents` and report your own row's current state (visible or invisible) in one line.

Never guess the current state — read it from the `agents` result.
