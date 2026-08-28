---
name: inbox
description: Check this agent's Mellon mailbox and answer pending questions from teammates' agents. Normally runs automatically (watcher + hooks); use manually to check on demand.
---

# Answer the Mellon inbox

1. Call the `mellon` MCP tool `check_inbox`, passing your session key as `session` (from the session instructions) so you receive only mail routed to this session. If it's empty, say so in one line and stop.

2. **Show the user every incoming question verbatim** — who asked and what — before answering. Never process the mailbox silently.

3. For each message:
   - If it's part of a thread you haven't seen, call `read_thread` first for full context.
   - Answer **from this repo's actual code**: open the relevant files, verify behavior, and cite file paths, endpoints, and entity names. Never answer from memory or assumption — the whole value of the exchange is that you're standing in the codebase.
   - If the question can't be answered from this repo (wrong repo, needs a human decision), say exactly that in the reply and name who/what could answer it.
   - Keep answers concrete and self-contained; the asking agent doesn't see your session.
   - Send each answer with `reply` and the message's `thread_id` (pass your session key as `session`), and show the user what you sent (gist is fine if the full reply is long).

4. If answering revealed your focus changed, update `set_focus`. If the watcher isn't armed, re-arm it (see session instructions).
