---
name: ask
description: Ask a teammate's agent a question through Mellon. Use when the current task depends on another repo/team's code, API contract, or decisions (e.g. "does the backend already support X?") instead of guessing.
---

# Ask a teammate's agent

Arguments (optional): who to ask and/or the question, e.g. `/mellon:ask bob does /order/summary include the $0 addon line?`

Steps:

1. Call the `mellon` MCP tool `agents` to see who is on the bridge: owner, description, online status, and current focus. Pick the recipient whose description/focus matches the question. If it's genuinely ambiguous who to ask, ask the user.

2. Compose the question. It must be **self-contained** — the recipient's agent does not see this conversation. Include:
   - Who is asking and from where (repo, branch, the task/ticket being worked on).
   - Enough context to answer precisely (what you're building, what you already know, relevant endpoint/entity names).
   - The concrete questions, numbered if more than one.
   - What form of answer helps (e.g. "endpoint + example response", "yes/no + file path").

3. Call `ask` with the recipient's agent id and the question. To follow up on an earlier exchange, pass its `thread_id` to stay in the same thread.

4. Report back to the user: who was asked, the thread id, and whether they're online (answer likely soon) or offline (queued in their mailbox). Do not block waiting for a reply.

5. When the user later wants the answer (or you need it to proceed), call `check_inbox` or `read_thread` with the thread id.
