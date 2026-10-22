// Shared "scouted" ticks for the TS32 Alliance Scout page.
// One Durable Object per board keeps the ticks in SQLite, logs every change, and pushes changes to open pages over WebSockets.
import { DurableObject } from "cloudflare:workers";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const COORD = /^-?\d{1,3}\|-?\d{1,3}$/;
const REF = { p: /^\d{1,10}$/, v: COORD, o: COORD };  // player uid, village x|y, oasis x|y
const valid = (kind, ref) => Object.hasOwn(REF, kind) && typeof ref === "string" && REF[kind].test(ref);
const cleanName = s => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);

export default {
  fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const board = new URL(req.url).pathname.match(/^\/([a-z0-9-]{1,32})\//);
    if (!board) return json({ error: "not found" }, 404);
    return env.BOARD.get(env.BOARD.idFromName(board[1])).fetch(req);
  },
};

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS marks (kind TEXT NOT NULL, ref TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, ref))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, state INTEGER NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const url = new URL(req.url), route = `${req.method} ${url.pathname.replace(/^\/[^/]+/, "")}`;
    try {
      switch (route) {
        case "GET /ws": return this.connect(req);
        case "GET /marks": return json(this.snapshot());
        case "GET /log": return json(this.history(Number(url.searchParams.get("limit")) || 200));
        case "POST /mark": return json(this.mark(await readJson(req)));
        case "POST /bulk": return json(this.bulk(await readJson(req)));
        case "POST /admin/rollback": return json(this.rollback(req, await readJson(req)));
        default: return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  }

  snapshot() {
    const marks = this.sql.exec("SELECT kind, ref, who, at FROM marks").toArray().map(r => [r.kind, r.ref, r.who, r.at]);
    return { marks, seq: this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM log").one().s };
  }

  history(limit) {
    return this.sql.exec("SELECT seq, kind, ref, state, who, at FROM log ORDER BY seq DESC LIMIT ?", Math.min(Math.max(limit, 1), 5000))
      .toArray().map(r => [r.seq, r.kind, r.ref, r.state, r.who, r.at]);
  }

  has(kind, ref) {
    return this.sql.exec("SELECT 1 FROM marks WHERE kind = ? AND ref = ?", kind, ref).toArray().length > 0;
  }

  // Set one tick on or off and log it; the log line can name someone else (a rollback) at another time.
  put(kind, ref, on, who, at, logWho = who, logAt = at) {
    if (on) this.sql.exec("INSERT OR REPLACE INTO marks (kind, ref, who, at) VALUES (?, ?, ?, ?)", kind, ref, who, at);
    else this.sql.exec("DELETE FROM marks WHERE kind = ? AND ref = ?", kind, ref);
    return this.sql.exec("INSERT INTO log (kind, ref, state, who, at) VALUES (?, ?, ?, ?, ?) RETURNING seq", kind, ref, on ? 1 : 0, logWho, logAt).one().seq;
  }

  mark({ kind, ref, on, who }) {
    if (!valid(kind, ref)) throw fail("bad mark");
    on = !!on; who = cleanName(who);
    if (this.has(kind, ref) === on) return { ok: true, changed: false };
    const at = Date.now(), seq = this.put(kind, ref, on, who, at);
    this.broadcast({ t: "mark", kind, ref, on, who, at, seq });
    return { ok: true, changed: true, seq };
  }

  // Add many ticks at once: a browser handing over the ticks it kept before they were shared.
  bulk({ marks, who }) {
    if (!Array.isArray(marks) || marks.length > 20000) throw fail("bad marks");
    who = cleanName(who);
    const at = Date.now();
    let added = 0;
    for (const m of marks) {
      const [kind, ref] = Array.isArray(m) ? m : [];
      if (valid(kind, ref) && !this.has(kind, ref)) { this.put(kind, ref, true, who, at); added++; }
    }
    if (added) this.broadcast({ t: "reload" });
    return { ok: true, added };
  }

  // Put every tick changed since `since` (ms) back the way it was then. Needs the ADMIN_KEY secret.
  rollback(req, { since }) {
    if (!this.env.ADMIN_KEY || req.headers.get("Authorization") !== `Bearer ${this.env.ADMIN_KEY}`) throw fail("forbidden", 403);
    if (!Number.isFinite(since)) throw fail("since must be a time in ms");
    const now = Date.now();
    let reverted = 0;
    for (const { kind, ref } of this.sql.exec("SELECT DISTINCT kind, ref FROM log WHERE at >= ?", since).toArray()) {
      const was = this.sql.exec("SELECT state, who, at FROM log WHERE kind = ? AND ref = ? AND at < ? ORDER BY seq DESC LIMIT 1", kind, ref, since).toArray()[0];
      const on = !!was?.state;
      if (this.has(kind, ref) === on) continue;
      this.put(kind, ref, on, was?.who ?? "", was?.at ?? now, "rollback", now);
      reverted++;
    }
    if (reverted) this.broadcast({ t: "reload" });
    return { ok: true, reverted };
  }

  connect(req) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a websocket" }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* socket is closing */ }
    }
  }

  webSocketMessage() { /* pages only send pings, which the auto-response answers */ }

  webSocketClose(ws) {
    try { ws.close(1000, "closing"); } catch { /* already closed */ }
  }
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > 1_000_000) throw fail("too large", 413);
  try { return JSON.parse(text || "{}"); } catch { throw fail("bad json"); }
}
