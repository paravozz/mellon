/// <reference types="@cloudflare/workers-types" />

// Mellon broker: presence directory + mailbox for coding agents.
// Plain HTTP endpoints (used by the plugin's presence hooks and watcher) + an
// MCP adapter at POST /mcp (used by the agents themselves). All free text by
// design — the schema is prose, because the clients are LLMs.
//
// Model: one AGENT per person (identity card, mailbox) with many SESSIONS
// (repo @ branch, focus, presence — one row per live Claude Code session).
// Messages may carry a free-text session_hint; a hinted message is delivered
// only to sessions whose info/focus matches it, unless no live session
// matches — then anyone may take it, so hinted mail never strands.

export interface Env {
  DB: D1Database;
  BRIDGE_TOKEN: string;
}

const ONLINE_TTL_MS = 10 * 60 * 1000;
const SERVER_INFO = { name: "mellon", version: "0.7.0" };

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
const fresh = (lastSeen: unknown) =>
  typeof lastSeen === "string" && Date.now() - Date.parse(lastSeen) < ONLINE_TTL_MS;

// ---------- agents & sessions ----------

async function touchAgent(
  env: Env,
  a: { id: string; owner?: string; description?: string },
) {
  await env.DB.prepare(
    `INSERT INTO agents (id, owner, description, last_seen, deregistered_at)
     VALUES (?1, ?2, ?3, ?4, NULL)
     ON CONFLICT(id) DO UPDATE SET
       owner       = CASE WHEN excluded.owner       != '' THEN excluded.owner       ELSE agents.owner       END,
       description = CASE WHEN excluded.description != '' THEN excluded.description ELSE agents.description END,
       last_seen = excluded.last_seen,
       deregistered_at = NULL`,
  )
    .bind(a.id, a.owner ?? "", a.description ?? "", now())
    .run();
}

// session_key "-" is the compatibility slot for clients that don't send one.
async function touchSession(env: Env, agentId: string, sessionKey: string, sessionInfo?: string) {
  await env.DB.prepare(
    `INSERT INTO sessions (agent_id, session_key, session_info, last_seen)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(agent_id, session_key) DO UPDATE SET
       session_info = CASE WHEN excluded.session_info != '' THEN excluded.session_info ELSE sessions.session_info END,
       last_seen = excluded.last_seen`,
  )
    .bind(agentId, sessionKey || "-", sessionInfo ?? "", now())
    .run();
}

async function liveSessions(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(
    "SELECT session_key, session_info, focus_summary, focus_updated_at, last_seen FROM sessions WHERE agent_id = ?1 ORDER BY last_seen DESC",
  )
    .bind(agentId)
    .all();
  return (results ?? []).filter((s: any) => fresh(s.last_seen));
}

async function register(
  env: Env,
  b: { id: string; owner?: string; description?: string; session?: string; session_key?: string },
) {
  await touchAgent(env, b);
  await touchSession(env, b.id, b.session_key ?? "-", b.session);
}

async function deregister(env: Env, id: string, sessionKey?: string) {
  if (sessionKey) {
    // End one session: expire its row; the agent goes offline when none are fresh.
    await env.DB.prepare(
      "UPDATE sessions SET last_seen = NULL WHERE agent_id = ?1 AND session_key = ?2",
    )
      .bind(id, sessionKey)
      .run();
    const live = await liveSessions(env, id);
    if (live.length === 0) {
      await env.DB.prepare("UPDATE agents SET deregistered_at = ?2 WHERE id = ?1").bind(id, now()).run();
    }
  } else {
    await env.DB.prepare("UPDATE sessions SET last_seen = NULL WHERE agent_id = ?1").bind(id).run();
    await env.DB.prepare("UPDATE agents SET deregistered_at = ?2 WHERE id = ?1").bind(id, now()).run();
  }
}

async function setFocus(env: Env, id: string, summary: string, sessionKey?: string) {
  const ts = now();
  await touchAgent(env, { id });
  await env.DB.prepare(
    `INSERT INTO sessions (agent_id, session_key, focus_summary, focus_updated_at, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(agent_id, session_key) DO UPDATE SET
       focus_summary = excluded.focus_summary,
       focus_updated_at = excluded.focus_updated_at,
       last_seen = excluded.last_seen`,
  )
    .bind(id, sessionKey || "-", summary, ts)
    .run();
  return { agent: id, session: sessionKey || "-", focus: summary, updated_at: ts };
}

// viewer: the asking agent's own id (from X-Agent-Id) — it always sees its own
// row truthfully. Invisible agents appear to everyone else as offline with no
// sessions — present in the directory (still reachable by mailbox).
async function listAgents(env: Env, viewer?: string) {
  const { results } = await env.DB.prepare("SELECT * FROM agents ORDER BY owner, id").all();
  const out = [];
  for (const r of (results ?? []) as any[]) {
    if (r.invisible && r.id !== viewer) {
      out.push({
        agent: r.id,
        owner: r.owner,
        description: r.description,
        online: false,
        last_seen: null,
        sessions: [],
      });
      continue;
    }
    const sessions = (await liveSessions(env, r.id)).map((s: any) => ({
      session: s.session_info,
      focus: { summary: s.focus_summary, updated_at: s.focus_updated_at },
      last_seen: s.last_seen,
    }));
    const left = r.deregistered_at && (!r.last_seen || Date.parse(r.deregistered_at) >= Date.parse(r.last_seen));
    out.push({
      agent: r.id,
      owner: r.owner,
      description: r.description,
      online: sessions.length > 0 && !left,
      last_seen: r.last_seen,
      sessions,
      ...(r.id === viewer ? { invisible: !!r.invisible } : {}),
    });
  }
  return out;
}

async function setGhost(env: Env, id: string, invisible: boolean) {
  await touchAgent(env, { id });
  await env.DB.prepare("UPDATE agents SET invisible = ?2 WHERE id = ?1")
    .bind(id, invisible ? 1 : 0)
    .run();
  return { agent: id, invisible };
}

// ---------- mail ----------

function sessionText(s: any): string {
  return `${s.session_info ?? ""} ${s.focus_summary ?? ""}`.toLowerCase();
}

// A hinted message is for session S when the hint matches S's repo/focus text.
// If NO live session of the agent matches the hint, the hint is void and any
// session may take the message (self-healing: hinted mail never strands).
async function unreadFor(env: Env, agentId: string, sessionKey?: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, thread_id, from_agent, body, created_at, session_hint FROM messages WHERE to_agent = ?1 AND read_at IS NULL ORDER BY id",
  )
    .bind(agentId)
    .all();
  const msgs = (results ?? []) as any[];
  if (msgs.length === 0) return msgs;

  const live = await liveSessions(env, agentId);
  const mine = sessionKey ? live.find((s: any) => (s.session_key || "-") === sessionKey) : undefined;

  return msgs.filter((m) => {
    const hint = (m.session_hint ?? "").trim().toLowerCase();
    if (!hint) return true;
    const anyMatch = live.some((s: any) => sessionText(s).includes(hint));
    if (!anyMatch) return true; // no live session matches — void the hint
    if (!sessionKey) return true; // caller is not session-scoped (old client / manual)
    return mine ? sessionText(mine).includes(hint) : false;
  });
}

async function inbox(env: Env, id: string, ack: boolean, sessionKey?: string) {
  const messages = await unreadFor(env, id, sessionKey);
  if (ack && messages.length) {
    // Ack exactly what we are returning, never blanket-unread.
    const ids = messages.map((m: any) => m.id);
    await env.DB.prepare(
      `UPDATE messages SET read_at = ?1 WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(now(), ...ids)
      .run();
  }
  await touchAgent(env, { id });
  if (sessionKey) await touchSession(env, id, sessionKey);
  return { messages: messages.map(({ id: _id, ...m }: any) => m) };
}

// Long-poll: hold the request open until a message lands for this agent (and
// session, when scoped) or the timeout passes. Waiting is itself presence.
async function waitForMessages(env: Env, id: string, timeoutSec: number, sessionKey?: string) {
  await touchAgent(env, { id });
  if (sessionKey) await touchSession(env, id, sessionKey);
  const deadline = Date.now() + Math.min(Math.max(timeoutSec, 1), 55) * 1000;
  for (;;) {
    const messages = await unreadFor(env, id, sessionKey);
    if (messages.length || Date.now() >= deadline) {
      return { messages: messages.map(({ id: _id, ...m }: any) => m) };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function sessionInfoOf(env: Env, agentId: string, sessionKey?: string): Promise<string> {
  if (!sessionKey) return "";
  const row = await env.DB.prepare(
    "SELECT session_info FROM sessions WHERE agent_id = ?1 AND session_key = ?2",
  )
    .bind(agentId, sessionKey)
    .first<any>();
  return row?.session_info ?? "";
}

async function ask(
  env: Env,
  from: string,
  to: string,
  body: string,
  threadId?: string,
  sessionHint?: string,
  fromSessionKey?: string,
) {
  const recipient = await env.DB.prepare("SELECT id FROM agents WHERE id = ?1").bind(to).first();
  if (!recipient) throw new HttpError(404, `unknown recipient agent: ${to}`);
  const tid = threadId?.trim() || `t_${crypto.randomUUID().slice(0, 8)}`;
  const fromSession = await sessionInfoOf(env, from, fromSessionKey);
  await env.DB.prepare(
    "INSERT INTO messages (thread_id, from_agent, to_agent, body, created_at, session_hint, from_session) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(tid, from, to, body, now(), sessionHint?.trim() || null, fromSession)
    .run();
  return { thread_id: tid, delivered_to: to };
}

async function reply(env: Env, from: string, threadId: string, body: string, fromSessionKey?: string) {
  const last = await env.DB.prepare(
    "SELECT from_agent, to_agent FROM messages WHERE thread_id = ?1 ORDER BY id DESC LIMIT 1",
  )
    .bind(threadId)
    .first<any>();
  if (!last) throw new HttpError(404, `unknown thread: ${threadId}`);
  const to = last.from_agent === from ? last.to_agent : last.from_agent;
  // Route the reply back to the session the counterpart last spoke from.
  const counterpart = await env.DB.prepare(
    "SELECT from_session FROM messages WHERE thread_id = ?1 AND from_agent = ?2 ORDER BY id DESC LIMIT 1",
  )
    .bind(threadId, to)
    .first<any>();
  const fromSession = await sessionInfoOf(env, from, fromSessionKey);
  await env.DB.prepare(
    "INSERT INTO messages (thread_id, from_agent, to_agent, body, created_at, session_hint, from_session) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(threadId, from, to, body, now(), counterpart?.from_session || null, fromSession)
    .run();
  return { thread_id: threadId, delivered_to: to };
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

const SESSION_ARG = {
  type: "string",
  description: "this session's mellon session key (given in the session instructions)",
};

const MCP_TOOLS = [
  {
    name: "agents",
    description:
      "List all agents on the bridge: owner, free-text description, online status, and their live sessions (repo @ branch, focus, last seen). Use this to decide who — and which of their sessions — to ask.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_focus",
    description:
      "Publish or update this session's focus — a 1-3 sentence free-text summary of what it is working on right now (ticket ids, repo, branch, progress; no schema, just prose).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "1-3 sentences, plain prose" },
        session: SESSION_ARG,
      },
      required: ["summary"],
    },
  },
  {
    name: "set_card",
    description:
      "Publish this agent's identity card: owner name and a free-text description (2-3 sentences — which repos/areas this agent knows, what teammates should ask it). Call after writing the mellon card file; hooks do not sync the card.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, description: { type: "string" } },
      required: ["description"],
    },
  },
  {
    name: "ask",
    description:
      "Send a question to another agent's mailbox. The question must be fully self-contained — the recipient does not see your conversation. Optionally target one of their sessions with session_hint (a short substring of that session's repo or focus, from the agents tool); hinted mail is delivered to the matching session, or to any session if none matches. Returns a thread_id for follow-ups.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient agent id, from the agents tool" },
        body: { type: "string", description: "the self-contained question" },
        thread_id: { type: "string", description: "optional: continue an existing thread" },
        session_hint: {
          type: "string",
          description: "optional: route to the recipient session whose repo/focus contains this text",
        },
        session: SESSION_ARG,
      },
      required: ["to", "body"],
    },
  },
  {
    name: "reply",
    description:
      "Reply within an existing thread. The reply is delivered to the other participant's mailbox and routed to the session they last spoke from.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        body: { type: "string" },
        session: SESSION_ARG,
      },
      required: ["thread_id", "body"],
    },
  },
  {
    name: "check_inbox",
    description:
      "Fetch unread messages addressed to this agent (scoped to this session when a session key is passed) and mark exactly those read. Also refreshes presence.",
    inputSchema: { type: "object", properties: { session: SESSION_ARG } },
  },
  {
    name: "set_ghost",
    description:
      "Toggle invisible mode for this agent. While invisible, other agents see it as offline with no sessions; asking and receiving questions keeps working normally.",
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
  const sessionKey = typeof args?.session === "string" && args.session.trim() ? args.session.trim() : undefined;
  switch (name) {
    case "agents":
      return listAgents(env, caller || undefined);
    case "set_focus":
      return setFocus(env, caller, need(args, "summary"), sessionKey);
    case "set_card":
      await touchAgent(env, { id: caller, owner: args?.owner, description: need(args, "description") });
      return { agent: caller, card_synced: true };
    case "ask":
      return ask(env, caller, need(args, "to"), need(args, "body"), args?.thread_id, args?.session_hint, sessionKey);
    case "reply":
      return reply(env, caller, need(args, "thread_id"), need(args, "body"), sessionKey);
    case "check_inbox":
      return inbox(env, caller, true, sessionKey);
    case "set_ghost":
      if (typeof args?.invisible !== "boolean") throw new HttpError(400, "missing field: invisible");
      return setGhost(env, caller, args.invisible);
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
        await register(env, {
          id: need(b, "agent_id"),
          owner: b.owner,
          description: b.description,
          session: b.session,
          session_key: b.session_key,
        });
        return json({ ok: true });
      }
      if (path === "/deregister" && req.method === "POST") {
        const b = await readBody(req);
        await deregister(env, need(b, "agent_id"), b.session_key);
        return json({ ok: true });
      }
      if (path === "/focus" && req.method === "POST") {
        const b = await readBody(req);
        return json(await setFocus(env, need(b, "agent_id"), need(b, "summary"), b.session_key));
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
        return json(
          await ask(env, need(b, "from"), need(b, "to"), need(b, "body"), b.thread_id, b.session_hint, b.session_key),
        );
      }
      if (path === "/reply" && req.method === "POST") {
        const b = await readBody(req);
        return json(await reply(env, need(b, "from"), need(b, "thread_id"), need(b, "body"), b.session_key));
      }
      if (path === "/inbox" && req.method === "GET") {
        const id = url.searchParams.get("agent_id")?.trim();
        if (!id) throw new HttpError(400, "missing query param: agent_id");
        return json(
          await inbox(env, id, url.searchParams.get("ack") !== "0", url.searchParams.get("session_key") ?? undefined),
        );
      }
      if (path === "/wait" && req.method === "GET") {
        const id = url.searchParams.get("agent_id")?.trim();
        if (!id) throw new HttpError(400, "missing query param: agent_id");
        const timeout = Number(url.searchParams.get("timeout") ?? "50");
        return json(
          await waitForMessages(
            env,
            id,
            Number.isFinite(timeout) ? timeout : 50,
            url.searchParams.get("session_key") ?? undefined,
          ),
        );
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
