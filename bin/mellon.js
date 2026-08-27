#!/usr/bin/env node
// Mellon one-command setup.
//
//   npx github:paravozz/mellon --server https://mellon-broker.<sub>.workers.dev --token <shared token>
//
// Optional:
//   --agent-id <id>      defaults to <username>-<hostname>
//   --owner <name>       defaults to the OS username
//   --description <txt>  agent card prose; defaults to a stub you edit later
//   --marketplace <ref>  plugin marketplace repo; defaults to paravozz/mellon
//   --no-plugin          skip `claude plugin` marketplace/install steps
//
// Writes env config into ~/.claude/settings.json, the agent card into
// ~/.claude/mellon-card.json, registers you on the broker, and installs the
// Claude Code plugin. Verifies the broker before touching anything.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

function arg(...names) {
  for (const name of names) {
    const i = process.argv.indexOf("--" + name);
    if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
      return process.argv[i + 1];
    }
  }
  return undefined;
}
const has = (name) => process.argv.includes("--" + name);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const die = (msg) => {
  console.error(`\nmellon: ${msg}`);
  process.exit(1);
};

async function main() {
  const server = (arg("server", "url") || "").replace(/\/+$/, "");
  const token = arg("token");
  if (!server || !token) {
    die(
      "usage: npx github:paravozz/mellon --server <broker url> --token <shared token> [--agent-id <id>]\n" +
        "Get the URL and token from whoever deployed your team's broker.",
    );
  }

  const username = os.userInfo().username;
  const host = os.hostname().split(".")[0];
  const agentId = slug(arg("agent-id", "agent_id") || `${username}-${host}`);
  const owner = arg("owner") || username;
  const description =
    arg("description") ||
    `${owner}'s agent on ${host}. (Stub card — edit ~/.claude/mellon-card.json or run /mellon:setup to describe what this agent knows and what to ask it.)`;
  const marketplace = arg("marketplace") || "paravozz/mellon";

  // 1. Verify the broker answers with this token before writing anything.
  process.stdout.write(`Checking broker ${server} ... `);
  let agents;
  try {
    const res = await fetch(`${server}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) die("broker rejected the token (401). Check --token.");
    if (!res.ok) die(`broker answered HTTP ${res.status}. Check --server.`);
    agents = await res.json();
    if (!Array.isArray(agents)) die("unexpected response from broker — is --server a Mellon broker?");
  } catch (e) {
    if (e.code === "ERR_INVALID_URL" || e instanceof TypeError) die(`cannot reach ${server}: ${e.message}`);
    throw e;
  }
  console.log("ok");

  // 2. Merge env config into ~/.claude/settings.json (preserving everything else).
  const claudeDir = path.join(os.homedir(), ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      die(`${settingsPath} exists but is not valid JSON — fix it first, nothing was changed.`);
    }
  }
  settings.env = {
    ...settings.env,
    MELLON_URL: server,
    MELLON_TOKEN: token,
    MELLON_AGENT_ID: agentId,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Wrote ${settingsPath} (env.MELLON_URL / MELLON_TOKEN / MELLON_AGENT_ID)`);

  // 3. Agent card — keep an existing one unless the user passed overrides.
  const cardPath = path.join(claudeDir, "mellon-card.json");
  if (!fs.existsSync(cardPath) || arg("owner") || arg("description")) {
    fs.writeFileSync(cardPath, JSON.stringify({ owner, description }, null, 2) + "\n");
    console.log(`Wrote ${cardPath}`);
  } else {
    console.log(`Kept existing ${cardPath}`);
  }

  // 4. Register on the broker so teammates see you immediately.
  try {
    await fetch(`${server}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, owner, description, session: "" }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`Registered "${agentId}" on the bridge`);
  } catch {
    console.log("Could not pre-register on the broker (will happen on first session start instead)");
  }

  // 5. Install the Claude Code plugin.
  if (!has("no-plugin")) {
    for (const cmd of [
      `claude plugin marketplace add ${marketplace}`,
      `claude plugin install mellon@mellon`,
    ]) {
      try {
        execSync(cmd, { stdio: "pipe", timeout: 120000 });
        console.log(`Ran: ${cmd}`);
      } catch (e) {
        const out = `${e.stdout || ""}${e.stderr || ""}`.trim().split("\n").pop() || e.message;
        console.log(`"${cmd}" did not succeed (${out})`);
        console.log("  Run it inside Claude Code instead: /plugin marketplace add " + marketplace + " then /plugin install mellon@mellon");
      }
    }
  }

  const others = agents.filter((a) => a.agent !== agentId).map((a) => `${a.agent} (${a.owner})`);
  console.log(
    `\nDone. Agent id: ${agentId}` +
      (others.length ? `\nAlready on this bridge: ${others.join(", ")}` : "\nYou are the first agent on this bridge.") +
      `\nRestart Claude Code to come online. Try /mellon:status, /mellon:ask, /mellon:inbox.`,
  );
}

main().catch((e) => die(e.message || String(e)));
