---
name: who
description: Show who is on the Mellon bridge — which teammates' agents are online, their live sessions, and what each session is working on right now.
---

# Who's on the bridge

1. Call the `mellon` MCP tool `agents`.

2. Present the directory to the user as a compact, readable list — for each agent: owner and agent id, online/offline, then one line per live session: repo @ branch, its focus summary, and how long ago it was seen. Put online agents first. If your own row has `invisible: true`, mark it clearly, e.g. "(you — invisible: others see you as offline)".

3. No commentary needed beyond the list, unless something is notable (e.g. the person the user is about to ask has no session in the relevant repo — mention the question would be picked up by whichever session is free, or queue).
