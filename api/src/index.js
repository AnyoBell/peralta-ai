// Peralta AI API — one Cloudflare Worker for chat, analytics and student data.
//
//   POST /chat         stream an AI reply (system prompt and limits live here, not in the browser)
//   POST /event        record one anonymous usage event (validated against EVENTS below)
//   POST /me           return everything stored for an anonymous ID
//   POST /me/delete    delete everything stored for an anonymous ID
//   GET  /insights     aggregate stats for editors          (Authorization: Bearer ADMIN_TOKEN)
//   GET  /export.csv   raw events as CSV for editors       (Authorization: Bearer ADMIN_TOKEN)
//
//   Optional sign-in with an approved school email (Authorization: Bearer <session token>):
//   POST /auth/start         email a 6-digit code         POST /auth/verify   exchange code for a session
//   POST /auth/logout        end the session              GET  /account       nickname, progress, rank
//   POST /account/progress   save best quiz scores / XP   POST /account/nick  set leaderboard nickname
//   POST /account/delete     delete the account           GET  /leaderboard   top students by learning outcomes
//
// Privacy rules enforced here: chat text is never written to the database, only allowlisted
// event fields are stored, raw IPs are never stored, and old data is deleted on a schedule.

const SYSTEM = `You are Peralta AI, a study assistant for community college students in the Peralta Community College District.
- Coach and explain rather than completing graded work. If a student asks you to write an essay, solve homework, or answer exam questions for them, offer to help them do it themselves instead: ask what they've tried, explain concepts, give feedback on their own draft.
- Keep answers clear and short enough to read on a phone. Use simple formatting.
- You can make mistakes. Never invent sources, citations or quotes. When facts matter, tell students to verify them.
- Don't ask for or repeat personal information such as names, emails, phone numbers or student ID numbers.`;

// Allowlisted events and their fields. Anything else is rejected.
const TABS = ["chat", "lib", "learn", "play", "help", "data", "review", "insights", "account"];
const EVENTS = {
  visit:           { returning: "bool" },
  tab_view:        { tab: TABS },
  module_start:    { module: "int:0:3" },
  practice_prompt: { module: "int:0:3", n: "int:0:5" },
  quiz_submit:     { module: "int:0:3", score: "int:0:30", total: "int:1:30", passed: "bool" },
  module_rating:   { module: "int:0:3", rating: "int:1:5" },
  lib_action:      { action: ["vote", "bm", "cpp", "use", "rep", "add", "pub"] },
  game_answer:     { round: "int:0:40", points: "int:0:30" },
  game_finish:     { xp: "int:0:1000" },
  chat_start:      {},
};
// Written by the server itself, never accepted from browsers.
const SERVER_EVENTS = ["chat_message", "chat_blocked"];

const AID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 86400000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
    const fail = (code, status = 400) => json({ error: code }, status);

    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isAdmin = path === "/insights" || path === "/export.csv";

    // Browser endpoints only answer your own site. (Admin endpoints use the token instead.)
    if (!isAdmin && !allowed.includes(origin)) return fail("origin_not_allowed", 403);

    try {
      if (req.method === "POST" && path === "/chat") return await chat(req, env, ctx, cors, fail);
      if (req.method === "POST" && path === "/event") return await event(req, env, json, fail);
      if (req.method === "POST" && path === "/me") return await me(req, env, json, fail);
      if (req.method === "POST" && path === "/me/delete") return await meDelete(req, env, json, fail);
      if (req.method === "POST" && path === "/auth/start") return await authStart(req, env, json, fail);
      if (req.method === "POST" && path === "/auth/verify") return await authVerify(req, env, json, fail);
      if (req.method === "GET" && path === "/leaderboard") return json(await leaderboard(env, await session(req, env)));
      if (path === "/auth/logout" || path.startsWith("/account")) {
        const uid = await session(req, env);
        if (!uid) return fail("signed_out", 401);
        if (req.method === "POST" && path === "/auth/logout") {
          await env.DB.prepare("DELETE FROM sessions WHERE thash = ?").bind(await sha256(bearer(req))).run();
          return json({ ok: true });
        }
        if (req.method === "GET" && path === "/account") return json(await account(env, uid));
        if (req.method === "POST" && path === "/account/progress") return await saveProgress(req, env, uid, json, fail);
        if (req.method === "POST" && path === "/account/nick") return await setNick(req, env, uid, json, fail);
        if (req.method === "POST" && path === "/account/delete") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM progress WHERE uid = ?").bind(uid),
            env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(uid),
            env.DB.prepare("DELETE FROM accounts WHERE uid = ?").bind(uid),
          ]);
          return json({ ok: true });
        }
      }
      if (req.method === "GET" && isAdmin) {
        if (!(await adminOk(req, env))) return fail("unauthorized", 401);
        if (path === "/insights") return json(await insights(env, url));
        return await exportCsv(env, cors);
      }
      return fail("not_found", 404);
    } catch (err) {
      console.error(err);
      return fail("server_error", 500);
    }
  },

  // Daily cleanup: retention for raw events, and old rate-limit counters.
  async scheduled(_event, env) {
    const days = +env.RETENTION_DAYS || 180;
    await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(Date.now() - days * DAY_MS).run();
    await env.DB.prepare("DELETE FROM limits WHERE day < ?").bind(dayKey(Date.now() - DAY_MS)).run();
    await env.DB.prepare("DELETE FROM codes WHERE expires < ?").bind(Date.now()).run();
    await env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
  },
};

// ---------- helpers ----------

async function body(req) {
  const text = await req.text();
  if (text.length > 64000) throw Object.assign(new Error("too_large"), { client: true });
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const okAid = (a) => typeof a === "string" && AID.test(a);

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validProps(name, props) {
  const spec = EVENTS[name];
  if (!spec) return null;
  if (props == null) props = {};
  if (typeof props !== "object" || Array.isArray(props)) return null;
  const out = {};
  for (const k of Object.keys(props)) if (!(k in spec)) return null; // no extra fields
  for (const [k, rule] of Object.entries(spec)) {
    const v = props[k];
    if (v === undefined) return null;
    if (Array.isArray(rule)) { if (!rule.includes(v)) return null; }
    else if (rule === "bool") { if (typeof v !== "boolean") return null; }
    else if (rule.startsWith("int:")) {
      const [, lo, hi] = rule.split(":").map(Number);
      if (!Number.isInteger(v) || v < lo || v > hi) return null;
    }
    out[k] = v;
  }
  return out;
}

async function log(env, aid, name, props) {
  await env.DB.prepare("INSERT INTO events (aid, name, props, ts) VALUES (?, ?, ?, ?)")
    .bind(aid, name, JSON.stringify(props || {}), Date.now()).run();
}

// Increments a daily counter and returns the new value.
async function bump(env, key, day) {
  const row = await env.DB.prepare(
    "INSERT INTO limits (k, n, day) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(key, day).first();
  return row ? row.n : 1;
}

async function adminOk(req, env) {
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const want = env.ADMIN_TOKEN || "";
  if (!want || got.length !== want.length) return false;
  // constant-time comparison
  const a = new TextEncoder().encode(got), b = new TextEncoder().encode(want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- /event ----------

async function event(req, env, json, fail) {
  const d = await body(req);
  if (!okAid(d.aid)) return fail("bad_id");
  if (SERVER_EVENTS.includes(d.name)) return fail("bad_event");
  const props = validProps(d.name, d.props);
  if (!props) return fail("bad_event");
  // Cap events per ID per day so one browser can't flood the database.
  const n = await bump(env, `ev:${d.aid}:${dayKey(Date.now())}`, dayKey(Date.now()));
  if (n > 2000) return fail("rate_limited", 429);
  await log(env, d.aid, d.name, props);
  return json({ ok: true });
}

// ---------- /chat ----------

async function chat(req, env, ctx, cors, fail) {
  const d = await body(req);
  if (!okAid(d.aid)) return fail("bad_id");
  const nolog = d.nolog === true;
  let msgs = Array.isArray(d.messages) ? d.messages : [];
  msgs = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-10);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return fail("bad_messages");
  // Keep the whole conversation within a sensible size.
  while (msgs.reduce((n, m) => n + m.content.length, 0) > 12000 && msgs.length > 1) msgs.shift();

  const now = Date.now(), day = dayKey(now);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = await sha256((env.IP_SALT || "") + day + ip); // salted, changes daily, never stored raw
  const blocked = async (reason) => {
    if (!nolog) await log(env, d.aid, "chat_blocked", { reason });
    return fail(reason, 429);
  };
  if ((await bump(env, `id:${d.aid}:${day}`, day)) > (+env.MSGS_PER_ID_PER_DAY || 60)) return blocked("rate_limited");
  if ((await bump(env, `ip:${ipKey}:${day}`, day)) > (+env.MSGS_PER_IP_PER_DAY || 2000)) return blocked("rate_limited");
  if ((await bump(env, `all:${day}`, day)) > (+env.MSGS_PER_DAY_TOTAL || 1500)) return blocked("daily_cap");

  const turn = Math.min(50, msgs.filter((m) => m.role === "user").length);
  const len = msgs[msgs.length - 1].content.length;
  const lenBucket = len < 60 ? "short" : len < 300 ? "medium" : "long";

  let stream;
  try {
    stream = await runModel(env, [{ role: "system", content: SYSTEM }, ...msgs]);
  } catch (err) {
    console.error("AI error", err);
    if (!nolog) ctx.waitUntil(log(env, d.aid, "chat_message", { turn, len: lenBucket, secs: 0, ok: false }));
    return fail("ai_unavailable", 503);
  }

  // Pass the stream straight through; record timing (not content) when it ends.
  const done = new TransformStream({
    flush() {
      if (!nolog) {
        const secs = Math.round((Date.now() - now) / 1000);
        ctx.waitUntil(log(env, d.aid, "chat_message", { turn, len: lenBucket, secs, ok: true }));
      }
    },
  });
  return new Response(stream.pipeThrough(done), {
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

async function runModel(env, messages) {
  if (env.MOCK_AI === "1") {
    // Local testing only: fake a streamed reply without calling Workers AI.
    const enc = new TextEncoder(), words = "This is a test reply from the mock model. ".split(" ");
    return new ReadableStream({
      start(c) {
        for (const w of words) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: w + " " })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
  }
  return env.AI.run(env.MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
    messages,
    stream: true,
    max_tokens: 700,
    temperature: 0.6,
  });
}

// ---------- /me ----------

async function me(req, env, json, fail) {
  const d = await body(req);
  if (!okAid(d.aid)) return fail("bad_id");
  const { results } = await env.DB.prepare(
    "SELECT name, props, ts FROM events WHERE aid = ? ORDER BY ts DESC LIMIT 1000"
  ).bind(d.aid).all();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE aid = ?").bind(d.aid).first();
  return json({
    count: count ? count.n : 0,
    retention_days: +env.RETENTION_DAYS || 180,
    events: results.map((r) => ({ name: r.name, props: JSON.parse(r.props || "{}"), ts: r.ts })),
  });
}

async function meDelete(req, env, json, fail) {
  const d = await body(req);
  if (!okAid(d.aid)) return fail("bad_id");
  const r = await env.DB.prepare("DELETE FROM events WHERE aid = ?").bind(d.aid).run();
  await env.DB.prepare("DELETE FROM limits WHERE k LIKE ?").bind(`%:${d.aid}:%`).run();
  return json({ ok: true, deleted: r.meta ? r.meta.changes : null });
}

// ---------- /insights ----------

async function insights(env, url) {
  const days = Math.min(365, Math.max(1, +url.searchParams.get("days") || 30));
  const since = Date.now() - days * DAY_MS;
  const q = async (sql, ...args) => (await env.DB.prepare(sql).bind(since, ...args).all()).results;
  const one = async (sql, ...args) => (await q(sql, ...args))[0] || {};

  const visitors = (await one("SELECT COUNT(DISTINCT aid) AS n FROM events WHERE ts >= ?")).n || 0;
  const returning = (await one(
    "SELECT COUNT(*) AS n FROM (SELECT aid FROM events WHERE ts >= ? GROUP BY aid HAVING COUNT(DISTINCT date(ts/1000,'unixepoch')) > 1)"
  )).n || 0;

  const distinct = async (where, ...args) =>
    (await one(`SELECT COUNT(DISTINCT aid) AS n FROM events WHERE ts >= ? AND ${where}`, ...args)).n || 0;

  // Funnel: visit -> Learn -> start module 1 -> pass modules 1-4
  const funnel = [
    { step: "Visited", n: visitors },
    { step: "Opened Learn", n: await distinct("name='tab_view' AND json_extract(props,'$.tab')='learn'") },
  ];
  for (let m = 0; m < 4; m++) {
    funnel.push({ step: `Started module ${m + 1}`, n: await distinct("name='module_start' AND json_extract(props,'$.module')=?", m) });
    funnel.push({ step: `Passed module ${m + 1}`, n: await distinct("name='quiz_submit' AND json_extract(props,'$.module')=? AND json_extract(props,'$.passed')=1", m) });
  }

  const tabs = await q(
    "SELECT json_extract(props,'$.tab') AS tab, COUNT(*) AS views, COUNT(DISTINCT aid) AS people FROM events WHERE ts >= ? AND name='tab_view' GROUP BY tab ORDER BY people DESC"
  );
  const library = await q(
    "SELECT json_extract(props,'$.action') AS action, COUNT(*) AS n, COUNT(DISTINCT aid) AS people FROM events WHERE ts >= ? AND name='lib_action' GROUP BY action ORDER BY n DESC"
  );
  const chat = await one(
    `SELECT COUNT(*) AS messages, COUNT(DISTINCT aid) AS people,
            ROUND(AVG(CASE WHEN json_extract(props,'$.ok')=1 THEN json_extract(props,'$.secs') END),1) AS avg_secs,
            SUM(CASE WHEN json_extract(props,'$.ok')=0 THEN 1 ELSE 0 END) AS failed
     FROM events WHERE ts >= ? AND name='chat_message'`
  );
  const chatBlocked = await q(
    "SELECT json_extract(props,'$.reason') AS reason, COUNT(*) AS n FROM events WHERE ts >= ? AND name='chat_blocked' GROUP BY reason"
  );
  const modules = await q(
    `SELECT m.module,
       (SELECT COUNT(DISTINCT aid) FROM events WHERE ts >= ?1 AND name='module_start' AND json_extract(props,'$.module')=m.module) AS started,
       (SELECT COUNT(DISTINCT aid) FROM events WHERE ts >= ?1 AND name='quiz_submit' AND json_extract(props,'$.module')=m.module) AS attempted,
       (SELECT COUNT(DISTINCT aid) FROM events WHERE ts >= ?1 AND name='quiz_submit' AND json_extract(props,'$.module')=m.module AND json_extract(props,'$.passed')=1) AS passed,
       (SELECT ROUND(AVG(CAST(json_extract(props,'$.score') AS REAL)/json_extract(props,'$.total'))*100) FROM events WHERE ts >= ?1 AND name='quiz_submit' AND json_extract(props,'$.module')=m.module) AS avg_pct,
       (SELECT ROUND(AVG(json_extract(props,'$.rating')),1) FROM events WHERE ts >= ?1 AND name='module_rating' AND json_extract(props,'$.module')=m.module) AS rating,
       (SELECT COUNT(*) FROM events WHERE ts >= ?1 AND name='module_rating' AND json_extract(props,'$.module')=m.module) AS ratings
     FROM (SELECT 0 AS module UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) m`
  );
  // Game drop-off: how far each player got
  const game = await q(
    `SELECT reached, COUNT(*) AS players FROM (
       SELECT aid, MAX(json_extract(props,'$.round'))+1 AS reached FROM events
       WHERE ts >= ? AND name='game_answer' GROUP BY aid) GROUP BY reached ORDER BY reached`
  );
  const gameFinished = await distinct("name='game_finish'");
  const daily = await q(
    "SELECT date(ts/1000,'unixepoch') AS day, COUNT(DISTINCT aid) AS people, COUNT(*) AS events FROM events WHERE ts >= ? GROUP BY day ORDER BY day"
  );

  // Live totals (no individual data)
  const now = Date.now();
  const live = {
    active_now: (await env.DB.prepare("SELECT COUNT(DISTINCT aid) AS n FROM events WHERE ts >= ?").bind(now - 5 * 60000).first()).n || 0,
    events_hour: (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ?").bind(now - 3600000).first()).n || 0,
    quizzes_today: (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND name='quiz_submit'").bind(now - DAY_MS).first()).n || 0,
    passes_today: (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND name='quiz_submit' AND json_extract(props,'$.passed')=1").bind(now - DAY_MS).first()).n || 0,
  };
  const accounts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.last >= ?1 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN a.nick IS NOT NULL THEN 1 ELSE 0 END) AS on_board,
            ROUND(AVG(p.score)) AS avg_score, ROUND(AVG(p.passed),1) AS avg_passed
     FROM accounts a LEFT JOIN progress p ON p.uid = a.uid`
  ).bind(since).first();
  const passedDist = (await env.DB.prepare(
    "SELECT COALESCE(p.passed,0) AS passed, COUNT(*) AS students FROM accounts a LEFT JOIN progress p ON p.uid=a.uid GROUP BY 1 ORDER BY 1"
  ).all()).results;
  const campuses = (await env.DB.prepare(
    "SELECT domain, COUNT(*) AS students FROM accounts GROUP BY domain ORDER BY students DESC"
  ).all()).results;

  return { live, accounts, passedDist, campuses, days, visitors, returning, funnel, tabs, library, chat, chatBlocked, modules, game, gameFinished, daily };
}

// ---------- /export.csv ----------

async function exportCsv(env, cors) {
  const { results } = await env.DB.prepare(
    "SELECT aid, name, props, ts FROM events ORDER BY ts LIMIT 100000"
  ).all();
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["anon_id,event,details,time_utc"].concat(
    results.map((r) => [r.aid, r.name, r.props, new Date(r.ts).toISOString()].map(esc).join(","))
  );
  return new Response(lines.join("\n"), {
    headers: {
      ...cors,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="peralta-ai-events-${dayKey(Date.now())}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// ---------- sign-in ----------

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,}$/;
const CODE_TTL = 10 * 60000, MAX_TRIES = 5, RESEND_WAIT = 60000, SESSION_DAYS = 30;
const NICK_RE = /^[A-Za-z0-9_ ]{2,16}$/;
const BAD_NICK = /(f+u+c+k|sh[i1]t|b[i1]tch|a+ss+h[o0]le|d[i1]ck|cunt|n[i1]gg|f[a@]g|wh[o0]re|sl[u]t|p[o0]rn|nazi|hitler)/i;

const bearer = (req) => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
const domains = (env) => (env.ALLOWED_EMAIL_DOMAINS || "").toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameStr(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function session(req, env) {
  const t = bearer(req);
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const row = await env.DB.prepare("SELECT uid FROM sessions WHERE thash = ? AND expires > ?").bind(await sha256(t), Date.now()).first();
  return row ? row.uid : null;
}

async function sendCode(env, email, code) {
  const subject = "Your Peralta AI sign-in code";
  const text = `Your Peralta AI sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;
  if (env.EMAIL && env.EMAIL_FROM) {
    await env.EMAIL.send({ to: email, from: env.EMAIL_FROM, subject, text });
    return "email";
  }
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return "email";
  }
  // No sender configured yet: the code is only visible to you, in `npx wrangler tail`.
  console.log(`[sign-in code] ${email.replace(/^(.).*@/, "$1***@")} -> ${code}`);
  return "log";
}

async function authStart(req, env, json, fail) {
  if (!env.EMAIL_KEY) return fail("signin_not_configured", 503);
  const d = await body(req);
  const email = String(d.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("bad_email");
  const domain = email.split("@")[1];
  if (!domains(env).includes(domain)) return json({ error: "domain_not_allowed", domains: domains(env) }, 400);

  const now = Date.now(), day = dayKey(now);
  const ehash = await hmac(env.EMAIL_KEY, email);
  const ipKey = await sha256((env.IP_SALT || "") + day + (req.headers.get("CF-Connecting-IP") || ""));
  const prev = await env.DB.prepare("SELECT sent FROM codes WHERE ehash = ?").bind(ehash).first();
  if (prev && now - prev.sent < RESEND_WAIT) return fail("wait_before_resend", 429);
  if ((await bump(env, `send:${ehash}:${day}`, day)) > 6) return fail("too_many_codes", 429);
  if ((await bump(env, `sendip:${ipKey}:${day}`, day)) > 300) return fail("too_many_codes", 429);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  await env.DB.prepare(
    "INSERT INTO codes (ehash, chash, expires, tries, sent) VALUES (?, ?, ?, 0, ?) ON CONFLICT(ehash) DO UPDATE SET chash = excluded.chash, expires = excluded.expires, tries = 0, sent = excluded.sent"
  ).bind(ehash, await hmac(env.EMAIL_KEY, `code:${ehash}:${code}`), now + CODE_TTL, now).run();

  let via;
  try { via = await sendCode(env, email, code); }
  catch (err) { console.error("send failed", err); return fail("send_failed", 502); }
  const out = { ok: true, via };
  if (env.DEV_RETURN_CODE === "1") out.code = code; // local testing only
  return json(out);
}

async function authVerify(req, env, json, fail) {
  if (!env.EMAIL_KEY) return fail("signin_not_configured", 503);
  const d = await body(req);
  const email = String(d.email || "").trim().toLowerCase();
  const code = String(d.code || "").replace(/\D/g, "");
  if (!EMAIL_RE.test(email) || code.length !== 6) return fail("bad_code");
  const ehash = await hmac(env.EMAIL_KEY, email);
  const row = await env.DB.prepare("SELECT chash, expires, tries FROM codes WHERE ehash = ?").bind(ehash).first();
  if (!row || row.expires < Date.now()) return fail("code_expired");
  if (row.tries >= MAX_TRIES) return fail("too_many_tries", 429);
  if (!sameStr(await hmac(env.EMAIL_KEY, `code:${ehash}:${code}`), row.chash)) {
    await env.DB.prepare("UPDATE codes SET tries = tries + 1 WHERE ehash = ?").bind(ehash).run();
    return json({ error: "wrong_code", left: MAX_TRIES - row.tries - 1 }, 400);
  }
  await env.DB.prepare("DELETE FROM codes WHERE ehash = ?").bind(ehash).run();

  const now = Date.now();
  let acct = await env.DB.prepare("SELECT uid FROM accounts WHERE ehash = ?").bind(ehash).first();
  if (!acct) {
    acct = { uid: crypto.randomUUID() };
    await env.DB.prepare("INSERT INTO accounts (uid, ehash, domain, created, last) VALUES (?, ?, ?, ?, ?)")
      .bind(acct.uid, ehash, email.split("@")[1], now, now).run();
  } else {
    await env.DB.prepare("UPDATE accounts SET last = ? WHERE uid = ?").bind(now, acct.uid).run();
  }
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (thash, uid, expires) VALUES (?, ?, ?)")
    .bind(await sha256(token), acct.uid, now + SESSION_DAYS * DAY_MS).run();
  return json({ token, account: await account(env, acct.uid) });
}

// ---------- progress + leaderboard ----------

// Points: 100 per module passed (80%+), up to 50 more per module for the best quiz score,
// and up to 50 from the best game XP (150 XP max in the game).
function scoreOf(res, xp) {
  let score = 0, passed = 0;
  for (let m = 0; m < 4; m++) {
    const r = res[m];
    if (!r) continue;
    const pct = r.s / r.n;
    if (pct >= 0.8) { passed++; score += 100; }
    score += Math.round(pct * 50);
  }
  return { score: score + Math.round(Math.min(xp, 150) / 3), passed };
}

async function account(env, uid) {
  const a = await env.DB.prepare(
    "SELECT a.nick, a.domain, a.created, p.res, p.xp, p.passed, p.score FROM accounts a LEFT JOIN progress p ON p.uid = a.uid WHERE a.uid = ?"
  ).bind(uid).first();
  if (!a) return null;
  const score = a.score || 0;
  const rank = a.nick
    ? ((await env.DB.prepare("SELECT COUNT(*) AS n FROM progress p JOIN accounts a ON a.uid = p.uid WHERE a.nick IS NOT NULL AND p.score > ?").bind(score).first()).n || 0) + 1
    : null;
  return { nick: a.nick, domain: a.domain, created: a.created, res: JSON.parse(a.res || "{}"), xp: a.xp || 0, passed: a.passed || 0, score, rank };
}

async function saveProgress(req, env, uid, json, fail) {
  const d = await body(req);
  const cur = await env.DB.prepare("SELECT res, xp FROM progress WHERE uid = ?").bind(uid).first();
  const res = cur ? JSON.parse(cur.res || "{}") : {};
  let xp = cur ? cur.xp : 0;
  // Merge, keeping the best result per module. Scores come from the browser, so they're
  // range-checked here; the leaderboard is meant for friendly competition, not grades.
  if (d.res && typeof d.res === "object") {
    for (let m = 0; m < 4; m++) {
      const r = d.res[m] ?? d.res[String(m)];
      if (!r || !Number.isInteger(r.s) || !Number.isInteger(r.n) || r.n < 1 || r.n > 30 || r.s < 0 || r.s > r.n) continue;
      const old = res[m];
      if (!old || r.s / r.n > old.s / old.n) res[m] = { s: r.s, n: r.n };
    }
  }
  if (Number.isInteger(d.xp) && d.xp >= 0 && d.xp <= 150) xp = Math.max(xp, d.xp);
  const { score, passed } = scoreOf(res, xp);
  await env.DB.prepare(
    "INSERT INTO progress (uid, res, xp, passed, score, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET res = excluded.res, xp = excluded.xp, passed = excluded.passed, score = excluded.score, updated = excluded.updated"
  ).bind(uid, JSON.stringify(res), xp, passed, score, Date.now()).run();
  await env.DB.prepare("UPDATE accounts SET last = ? WHERE uid = ?").bind(Date.now(), uid).run();
  return json(await account(env, uid));
}

async function setNick(req, env, uid, json, fail) {
  const d = await body(req);
  const nick = String(d.nick || "").replace(/\s+/g, " ").trim();
  if (!NICK_RE.test(nick)) return fail("bad_nick");
  if (BAD_NICK.test(nick.replace(/[\s_]/g, ""))) return fail("nick_not_allowed");
  if (/@|\d{7,}/.test(nick)) return fail("nick_not_allowed");
  const taken = await env.DB.prepare("SELECT uid FROM accounts WHERE lower(nick) = lower(?) AND uid != ?").bind(nick, uid).first();
  if (taken) return fail("nick_taken");
  await env.DB.prepare("UPDATE accounts SET nick = ? WHERE uid = ?").bind(nick, uid).run();
  return json(await account(env, uid));
}

async function leaderboard(env, uid) {
  const { results } = await env.DB.prepare(
    `SELECT a.uid, a.nick, p.score, p.passed FROM progress p JOIN accounts a ON a.uid = p.uid
     WHERE a.nick IS NOT NULL AND p.score > 0 ORDER BY p.score DESC, p.updated ASC LIMIT 20`
  ).all();
  return {
    top: results.map((r, i) => ({ rank: i + 1, nick: r.nick, score: r.score, passed: r.passed, me: !!uid && r.uid === uid })),
    me: uid ? await account(env, uid) : null,
    updated: Date.now(),
  };
}
