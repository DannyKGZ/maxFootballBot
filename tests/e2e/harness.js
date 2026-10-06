// Тестовый стенд: подставной MAX Bot API в этом процессе + настоящий бот
// (dist/index.js) отдельным процессом с временной папкой данных.
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "../..");
const GROUP = -1;
const ADMINS = [1];
const DENIED_DM = [9]; // этот пользователь «не открывал бота» — личка ему запрещена
const USERS = { 1: "Админ", 2: "Ruslan", 3: "Рома", 4: "Влад", 5: "Пятый", 6: "Шестой", 9: "Чужой" };
const dmOf = (uid) => 5000 + uid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Подставной MAX: хранит сообщения, ответы на кнопки и лог вызовов. */
function startMock() {
  let seq = 0;
  const messages = new Map();
  // Участники группы для /Всем; отдаются страницами по 2, чтобы проверять marker.
  const state = {
    // long polling: очередь событий для GET /updates и ждущие запросы
    updates: [],
    waiters: [],
    subscriptions: [{ url: "https://old-tunnel.trycloudflare.com/webhook", time: 0 }],
    deletedSubscriptions: [],
    hangOnce: new Set(), // пути, на которых «MAX» один раз не отвечает (проверка таймаутов)
    // У Ромы и Влада есть фамилия (name = «имя фамилия») — как у части людей в реальном чате.
    members: [
      ...Object.entries(USERS).map(([id, name]) => {
        const last = { 3: "Власенко", 4: "Тюев" }[id];
        return last
          ? { user_id: Number(id), first_name: name, last_name: last, name: `${name} ${last}` }
          : { user_id: Number(id), first_name: name, last_name: "", name };
      }),
      { user_id: 777, first_name: "Бот", is_bot: true },
    ],
  };
  const answers = [];
  const calls = [];
  const send = (res, obj, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const b = body ? JSON.parse(body) : {};
      const p = u.pathname;
      const mid = u.searchParams.get("message_id");
      calls.push(`${req.method} ${p}${u.search}`);
      if (state.hangOnce.has(p)) {
        state.hangOnce.delete(p);
        return; // не отвечаем — как зависшее соединение
      }
      if (req.method === "POST" && p === "/messages") {
        const userId = Number(u.searchParams.get("user_id")) || 0;
        if (DENIED_DM.includes(userId)) return send(res, { code: "chat.denied" }, 403);
        const id = "mid." + ++seq;
        messages.set(id, { mid: id, chat: Number(u.searchParams.get("chat_id")) || 0, user: userId, text: b.text, format: b.format, attachments: b.attachments || [] });
        return send(res, { message: { body: { mid: id, seq } } });
      }
      if (req.method === "PUT" && p === "/messages") {
        const m = messages.get(mid);
        if (!m) return send(res, { success: false }, 404);
        Object.assign(m, { text: b.text, attachments: b.attachments || [] });
        return send(res, { success: true });
      }
      if (req.method === "DELETE" && p === "/messages") {
        return messages.delete(mid) ? send(res, { success: true }) : send(res, { success: false }, 404);
      }
      if (p === "/answers") {
        answers.push(b.notification);
        return send(res, { success: true });
      }
      if (p.endsWith("/members/admins")) return send(res, { members: ADMINS.map((user_id) => ({ user_id })) });
      if (p.endsWith("/members")) {
        const size = Math.min(Number(u.searchParams.get("count") || 20), 100);
        const from = Number(u.searchParams.get("marker") || 0);
        const page = state.members.slice(from, from + size);
        const next = from + size < state.members.length ? from + size : null;
        return send(res, { members: page, marker: next });
      }
      if (req.method === "GET" && p === "/updates") {
        // marker = сколько событий клиент уже получил; ждём новые до timeout секунд
        const from = Number(u.searchParams.get("marker") || 0);
        const reply = () => send(res, { updates: state.updates.slice(from), marker: state.updates.length });
        if (state.updates.length > from) return reply();
        const timer = setTimeout(reply, Number(u.searchParams.get("timeout") || 0) * 1000);
        state.waiters.push(() => {
          clearTimeout(timer);
          reply();
        });
        return;
      }
      if (req.method === "GET" && p === "/subscriptions") return send(res, { subscriptions: state.subscriptions });
      if (req.method === "DELETE" && p === "/subscriptions") {
        const url = u.searchParams.get("url");
        state.deletedSubscriptions.push(url);
        state.subscriptions = state.subscriptions.filter((x) => x.url !== url);
        return send(res, { success: true });
      }
      if (p === "/me/commands") {
        state.commands = b.commands;
        return send(res, { success: true });
      }
      if (p === "/me/commands") {
        state.commands = b.commands;
        return send(res, { success: true });
      }
      if (p.endsWith("/pin") || p === "/subscriptions") return send(res, { success: true });
      send(res, {}, 404);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({
        port: server.address().port,
        messages,
        state,
        answers,
        calls,
        close: () => {
          for (const w of state.waiters.splice(0)) w(); // отпустить висящие long-poll запросы
          return new Promise((r) => server.close(r));
        },
      }),
    ),
  );
}

class Harness {
  constructor(scenario) {
    this.scenario = scenario;
    this.pass = 0;
    this.fail = 0;
    this.ts = 1;
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mfb-e2e-"));
  }

  async start() {
    this.mock = await startMock();
    this.botPort = await freePort();
    if (this.scenario.preload) this.scenario.preload(this.dataDir);
    await this.startBot();
  }

  async startBot() {
    const env = {
      ...process.env,
      BOT_TOKEN: "test",
      CHAT_ID: String(GROUP),
      PORT: String(this.botPort),
      WEBHOOK_SECRET: "",
      AUTO_REGISTER_WEBHOOK: "false",
      MAX_API_BASE_URL: `http://127.0.0.1:${this.mock.port}`,
      DOTENV_CONFIG_PATH: path.join(this.dataDir, "no.env"), // ваш .env в тесты не попадает
      DB_FILE: path.join(this.dataDir, "bot.db"),
      SESSIONS_FILE: path.join(this.dataDir, "sessions.json"),
      SCHEDULE_FILE: path.join(this.dataDir, "schedule.json"),
      MVP_FILE: path.join(this.dataDir, "mvp.json"),
      CRON_SCHEDULE: "0 0 1 1 *", // чтобы расписание не сработало посреди теста
      MAX_PLAYERS: "15",
      REMINDER_HOURS_BEFORE: "0",
      PAYMENT_HOURS_BEFORE: "0",
      PAYMENT_HOURS_AFTER: "0",
      VOTE_AUTO_CLOSE_HOURS: "0",
      VOTE_AUTO_START_MINUTES: "0", // автозапуск голосования проверяется отдельным сценарием
      VOTE_AUTO_START_MINUTES: "0", // автозапуск голосования проверяется отдельным сценарием
      ...(this.scenario.env || {}),
    };
    this.log = "";
    this.bot = spawn(process.execPath, [path.join(ROOT, "dist/index.js")], { env, cwd: ROOT });
    this.bot.stdout.on("data", (d) => (this.log += d));
    this.bot.stderr.on("data", (d) => (this.log += d));
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${this.botPort}/health`)).ok) return;
      } catch {}
      await sleep(100);
    }
    throw new Error("бот не запустился:\n" + this.log);
  }

  async stopBot() {
    if (!this.bot || this.bot.exitCode !== null) return;
    const exited = new Promise((r) => this.bot.once("exit", r));
    this.bot.kill("SIGTERM"); // бот сохраняет состояние при SIGTERM
    await exited;
  }

  async restartBot() {
    await this.stopBot();
    await this.startBot();
  }

  async stop() {
    await this.stopBot();
    await this.mock.close();
    fs.rmSync(this.dataDir, { recursive: true, force: true });
  }

  /** Ждёт, пока бот перестанет обращаться к MAX (очередь лимитов — до 0,5 с между вызовами). */
  async idle(quietMs = 900) {
    let last = -1;
    let stableSince = Date.now();
    await sleep(150);
    for (;;) {
      const n = this.mock.calls.length;
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) return;
      await sleep(100);
    }
  }

  post(update) {
    if (this.scenario.env && this.scenario.env.UPDATES_MODE === "polling") {
      // В режиме polling событие не шлётся боту, а кладётся в очередь MAX — бот заберёт его сам.
      const st = this.mock.state;
      st.updates.push(update);
      const waiting = st.waiters.splice(0);
      for (const w of waiting) w();
      return Promise.resolve();
    }
    return fetch(`http://127.0.0.1:${this.botPort}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
  }

  sender(uid) {
    return { user_id: uid, first_name: USERS[uid], last_name: "", name: USERS[uid], is_bot: false };
  }

  recipient(uid, dm) {
    return dm ? { chat_id: dmOf(uid), chat_type: "dialog" } : { chat_id: GROUP, chat_type: "chat" };
  }

  messageUpdate(uid, text, dm = false) {
    const ts = this.ts++;
    return {
      update_type: "message_created",
      timestamp: ts,
      message: { sender: this.sender(uid), recipient: this.recipient(uid, dm), timestamp: ts, body: { mid: "u." + ts, seq: ts, text } },
    };
  }

  /** Пользователь пишет сообщение (в группу или боту в личку). */
  async say(uid, text, { dm = false } = {}) {
    await this.post(this.messageUpdate(uid, text, dm));
    await this.idle();
  }

  /** Пользователь нажимает кнопку, чей текст начинается с `label`, под сообщением `msg`. */
  async click(uid, msg, label, { dm = false } = {}) {
    const btn = this.buttons(msg, true).find((b) => b.text.startsWith(label));
    if (!btn) throw new Error(`нет кнопки «${label}» под сообщением: ${msg && msg.text}`);
    const ts = this.ts++;
    await this.post({
      update_type: "message_callback",
      timestamp: ts,
      callback: { callback_id: "c" + ts, payload: btn.payload, user: this.sender(uid) },
      message: { recipient: this.recipient(uid, dm), body: { mid: msg.mid } },
    });
    await this.idle();
  }

  async botStarted(uid) {
    await this.post({ update_type: "bot_started", timestamp: this.ts++, chat_id: dmOf(uid), user: this.sender(uid) });
    await this.idle();
  }

  // ---- чтение состояния подставного MAX ----
  all(chat = GROUP) {
    return [...this.mock.messages.values()].filter((m) => chat === undefined || m.chat === chat);
  }
  find(re, chat = GROUP) {
    return this.all(chat).filter((m) => re.test(m.text)).pop();
  }
  count(re, chat = GROUP) {
    return this.all(chat).filter((m) => re.test(m.text)).length;
  }
  dmTo(uid) {
    return [...this.mock.messages.values()].filter((m) => m.chat === dmOf(uid) || m.user === uid);
  }
  roster() {
    return this.find(/^Футбол в/);
  }
  lines(msg) {
    return msg ? msg.text.split("\n").filter((l) => /^\d+\./.test(l)) : [];
  }
  buttons(msg, raw = false) {
    const list = msg ? msg.attachments.flatMap((a) => a.payload.buttons.flat()) : [];
    return raw ? list : list.map((b) => b.text);
  }
  toast() {
    return this.mock.answers[this.mock.answers.length - 1];
  }
  /** SQL-запрос к базе бота (только чтение). */
  query(sql, ...params) {
    const d = new Database(path.join(this.dataDir, "bot.db"), { readonly: true });
    try {
      return d.prepare(sql).all(...params);
    } finally {
      d.close();
    }
  }
  mvpCount(name, chat = GROUP) {
    const row = this.query("SELECT count FROM mvp_players WHERE chat_id = ? AND name_key = ?", chat, name.toLowerCase())[0];
    return row ? row.count : 0;
  }
  archived(chat = GROUP) {
    const row = this.query("SELECT data FROM archived_sessions WHERE chat_id = ?", chat)[0];
    return row ? JSON.parse(row.data) : null;
  }
  savedSchedule() {
    return this.query("SELECT cron, days, time FROM schedule WHERE id = 1")[0] || null;
  }
  fileExists(file) {
    return fs.existsSync(path.join(this.dataDir, file));
  }

  ok(cond, name, detail = "") {
    if (cond) this.pass++;
    else this.fail++;
    console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `\n      → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

module.exports = { Harness, GROUP, dmOf, sleep };
