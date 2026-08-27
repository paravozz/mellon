/// <reference types="@cloudflare/workers-types" />

// Mellon broker: presence directory + mailbox for coding agents.
// Plain HTTP endpoints (used by the plugin's presence hooks) + an MCP adapter
// at POST /mcp (used by the agents themselves). All free text by design —
// the schema is prose, because the clients are LLMs.

export interface Env {
  DB: D1Database;
  BRIDGE_TOKEN: string;
}

const ONLINE_TTL_MS = 10 * 60 * 1000;
const SERVER_INFO = { name: "mellon", version: "0.1.0" };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function need(obj: any, field: string): string {
  const v = obj?.[field];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `missing field: ${field}`);
  return v.trim();
}

const now = () => new Date().toISOString();

// ---------- core operations (shared by HTTP endpoints and MCP tools) ----------

async function touchAgent(
  env: Env,
  a: { id: string; owner?: string; description?: string; session?: string },
) {
  await env.DB.prepare(
    `INSERT INTO agents (id, owner, description, session_info, last_seen, deregistered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)
     ON CONFLICT(id) DO UPDATE SET
       owner        = CASE WHEN excluded.owner        != '' THEN excluded.owner        ELSE agents.owner        END,
       description  = CASE WHEN excluded.description  != '' THEN excluded.description  ELSE agents.description  END,
       session_info = CASE WHEN excluded.session_info != '' THEN excluded.session_info ELSE agents.session_info END,
       last_seen = excluded.last_seen,
       deregistered_at = NULL`,
  )
    .bind(a.id, a.owner ?? "", a.description ?? "", a.session ?? "", now())
    .run();
}

async function deregister(env: Env, id: string) {
  await env.DB.prepare("UPDATE agents SET deregistered_at = ?2 WHERE id = ?1").bind(id, now()).run();
}

async function setFocus(env: Env, id: string, summary: string) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO agents (id, focus_summary, focus_updated_at, last_seen)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(id) DO UPDATE SET
       focus_summary = excluded.focus_summary,
       focus_updated_at = excluded.focus_updated_at,
       last_seen = excluded.last_seen,
       deregistered_at = NULL`,
  )
    .bind(id, summary, ts)
    .run();
  return { agent: id, focus: summary, updated_at: ts };
}

// viewer: the asking agent's own id (from X-Agent-Id), so it always sees its own
// row truthfully. Invisible agents appear to everyone else as offline with no
// session, focus, or last-seen — present in the directory (still reachable by
// mailbox), just without presence.
async function listAgents(env: Env, viewer?: string) {
  const { results } = await env.DB.prepare("SELECT * FROM agents ORDER BY owner, id").all();
  const t = Date.now();
  return (results ?? []).map((r: any) => {
    if (r.invisible && r.id !== viewer) {
      return {
        agent: r.id,
        owner: r.owner,
        description: r.description,
        online: false,
        last_seen: null,
        session: "",
        focus: { summary: "", updated_at: null },
      };
    }
    const lastSeen = r.last_seen ? Date.parse(r.last_seen) : 0;
    const left = r.deregistered_at && Date.parse(r.deregistered_at) >= lastSeen;
    return {
      agent: r.id,
      owner: r.owner,
      description: r.description,
      online: !left && t - lastSeen < ONLINE_TTL_MS,
      last_seen: r.last_seen,
      session: r.session_info,
      focus: { summary: r.focus_summary, updated_at: r.focus_updated_at },
      ...(r.id === viewer ? { invisible: !!r.invisible } : {}),
    };
  });
}

async function setGhost(env: Env, id: string, invisible: boolean) {
  await touchAgent(env, { id });
  await env.DB.prepare("UPDATE agents SET invisible = ?2 WHERE id = ?1")
    .bind(id, invisible ? 1 : 0)
    .run();
  return { agent: id, invisible };
}

async function ask(env: Env, from: string, to: string, body: string, threadId?: string) {
  const recipient = await env.DB.prepare("SELECT id FROM agents WHERE id = ?1").bind(to).first();
  if (!recipient) throw new HttpError(404, `unknown recipient agent: ${to}`);
  const tid = threadId?.trim() || `t_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    "INSERT INTO messages (thread_id, from_agent, to_agent, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(tid, from, to, body, now())
    .run();
  return { thread_id: tid, delivered_to: to };
}

async function reply(env: Env, from: string, threadId: string, body: string) {
  const last = await env.DB.prepare(
    "SELECT from_agent, to_agent FROM messages WHERE thread_id = ?1 ORDER BY id DESC LIMIT 1",
  )
    .bind(threadId)
    .first<any>();
  if (!last) throw new HttpError(404, `unknown thread: ${threadId}`);
  const to = last.from_agent === from ? last.to_agent : last.from_agent;
  await env.DB.prepare(
    "INSERT INTO messages (thread_id, from_agent, to_agent, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(threadId, from, to, body, now())
    .run();
  return { thread_id: threadId, delivered_to: to };
}

async function getUnread(env: Env, id: string) {
  const { results } = await env.DB.prepare(
    "SELECT thread_id, from_agent, body, created_at FROM messages WHERE to_agent = ?1 AND read_at IS NULL ORDER BY id",
  )
    .bind(id)
    .all();
  return results ?? [];
}

async function inbox(env: Env, id: string, ack: boolean) {
  const messages = await getUnread(env, id);
  if (ack && messages.length) {
    await env.DB.prepare("UPDATE messages SET read_at = ?1 WHERE to_agent = ?2 AND read_at IS NULL")
      .bind(now(), id)
      .run();
  }
  await touchAgent(env, { id }); // inbox polls double as heartbeats
  return { messages };
}

// Long-poll: hold the request open until a message lands for this agent or the
// timeout passes. Sleeping costs no Worker CPU; the D1 check every 2.5s is cheap.
// Waiting is itself presence — a watching session is online by definition.
async function waitForMessages(env: Env, id: string, timeoutSec: number) {
  await touchAgent(env, { id });
  const deadline = Date.now() + Math.min(Math.max(timeoutSec, 1), 55) * 1000;
  for (;;) {
    const messages = await getUnread(env, id);
    if (messages.length || Date.now() >= deadline) return { messages };
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function readThread(env: Env, threadId: string) {
  const { results } = await env.DB.prepare(
    "SELECT from_agent, to_agent, body, created_at FROM messages WHERE thread_id = ?1 ORDER BY id",
  )
    .bind(threadId)
    .all();
  if (!results?.length) throw new HttpError(404, `unknown thread: ${threadId}`);
  return { thread_id: threadId, messages: results };
}

// ---------- MCP adapter (streamable HTTP, stateless JSON responses) ----------

const MCP_TOOLS = [
  {
    name: "agents",
    description:
      "List all agents on the bridge: owner, free-text description, online status, current session (repo @ branch), and current focus. Use this to decide who to ask.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_focus",
    description:
      "Publish or update this agent's focus — a 1-3 sentence free-text summary of what it is working on right now (ticket ids, repo, branch, progress; no schema, just prose).",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "1-3 sentences, plain prose" } },
      required: ["summary"],
    },
  },
  {
    name: "ask",
    description:
      "Send a question to another agent's mailbox. The question must be fully self-contained — the recipient does not see your conversation. Returns a thread_id for follow-ups.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient agent id, from the agents tool" },
        body: { type: "string", description: "the self-contained question" },
        thread_id: { type: "string", description: "optional: continue an existing thread" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "reply",
    description: "Reply within an existing thread. The reply is delivered to the other participant's mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        body: { type: "string" },
      },
      required: ["thread_id", "body"],
    },
  },
  {
    name: "check_inbox",
    description: "Fetch unread messages addressed to this agent and mark them read. Also refreshes this agent's presence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_card",
    description:
      "Publish this agent's identity card: owner name and a free-text description (2-3 sentences — which repos/areas this agent knows, what teammates should ask it). Call after writing ~/.claude/mellon-card.json; hooks do not sync the card.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, description: { type: "string" } },
      required: ["description"],
    },
  },
  {
    name: "set_ghost",
    description:
      "Toggle invisible mode for this agent. While invisible, other agents see it as offline with no session, focus, or last-seen; asking and receiving questions keeps working normally.",
    inputSchema: {
      type: "object",
      properties: { invisible: { type: "boolean" } },
      required: ["invisible"],
    },
  },
  {
    name: "read_thread",
    description: "Read the full message history of a thread.",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" } },
      required: ["thread_id"],
    },
  },
];

async function callTool(env: Env, caller: string, name: string, args: any): Promise<unknown> {
  switch (name) {
    case "agents":
      return listAgents(env, caller || undefined);
    case "set_focus":
      return setFocus(env, caller, need(args, "summary"));
    case "set_card":
      await touchAgent(env, { id: caller, owner: args?.owner, description: need(args, "description") });
      return { agent: caller, card_synced: true };
    case "set_ghost":
      if (typeof args?.invisible !== "boolean") throw new HttpError(400, "missing field: invisible");
      return setGhost(env, caller, args.invisible);
    case "ask":
      return ask(env, caller, need(args, "to"), need(args, "body"), args?.thread_id);
    case "reply":
      return reply(env, caller, need(args, "thread_id"), need(args, "body"));
    case "check_inbox":
      return inbox(env, caller, true);
    case "read_thread":
      return readThread(env, need(args, "thread_id"));
    default:
      throw new HttpError(400, `unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

async function handleMcp(env: Env, req: Request): Promise<Response> {
  const caller = req.headers.get("X-Agent-Id")?.trim() ?? "";
  const msg = await readBody(req);

  // Notifications (no id) need no response body.
  if (msg?.id === undefined || msg?.id === null) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return json(
        rpcResult(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
    case "ping":
      return json(rpcResult(msg.id, {}));
    case "tools/list":
      return json(rpcResult(msg.id, { tools: MCP_TOOLS }));
    case "tools/call": {
      const name = msg.params?.name;
      const needsIdentity = name !== "agents" && name !== "read_thread";
      try {
        if (needsIdentity && !caller) {
          throw new HttpError(401, "missing X-Agent-Id header (set MELLON_AGENT_ID)");
        }
        const result = await callTool(env, caller, name, msg.params?.arguments ?? {});
        return json(
          rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }),
        );
      } catch (e: any) {
        return json(
          rpcResult(msg.id, {
            content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
            isError: true,
          }),
        );
      }
    }
    default:
      return json({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
  }
}

// ---------- HTTP routing ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && req.method === "GET") {
      return json({ ok: true, service: "mellon-broker", hint: "speak, friend, and enter" });
    }

    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.BRIDGE_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (path === "/mcp" && req.method === "POST") return handleMcp(env, req);

      if (req.method === "POST" && (path === "/register" || path === "/heartbeat")) {
        const b = await readBody(req);
        await touchAgent(env, {
          id: need(b, "agent_id"),
          owner: b.owner,
          description: b.description,
          session: b.session,
        });
        return json({ ok: true });
      }
      if (path === "/deregister" && req.method === "POST") {
        const b = await readBody(req);
        await deregister(env, need(b, "agent_id"));
        return json({ ok: true });
      }
      if (path === "/focus" && req.method === "POST") {
        const b = await readBody(req);
        return json(await setFocus(env, need(b, "agent_id"), need(b, "summary")));
      }
      if (path === "/agents" && req.method === "GET") {
        return json(await listAgents(env));
      }
      if (path === "/ghost" && req.method === "POST") {
        const b = await readBody(req);
        if (typeof b?.invisible !== "boolean") throw new HttpError(400, "missing field: invisible");
        return json(await setGhost(env, need(b, "agent_id"), b.invisible));
      }
      if (path === "/ask" && req.method === "POST") {
        const b = await readBody(req);
        return json(await ask(env, need(b, "from"), need(b, "to"), need(b, "body"), b.thread_id));
      }
      if (path === "/reply" && req.method === "POST") {
        const b = await readBody(req);
        return json(await reply(env, need(b, "from"), need(b, "thread_id"), need(b, "body")));
      }
      if (path === "/inbox" && req.method === "GET") {
        const id = url.searchParams.get("agent_id")?.trim();
        if (!id) throw new HttpError(400, "missing query param: agent_id");
        return json(await inbox(env, id, url.searchParams.get("ack") !== "0"));
      }
      if (path === "/wait" && req.method === "GET") {
        const id = url.searchParams.get("agent_id")?.trim();
        if (!id) throw new HttpError(400, "missing query param: agent_id");
        const timeout = Number(url.searchParams.get("timeout") ?? "50");
        return json(await waitForMessages(env, id, Number.isFinite(timeout) ? timeout : 50));
      }
      if (path.startsWith("/thread/") && req.method === "GET") {
        return json(await readThread(env, decodeURIComponent(path.slice("/thread/".length))));
      }

      return json({ error: "not found" }, 404);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: e?.message ?? "internal error" }, 500);
    }
  },
};
