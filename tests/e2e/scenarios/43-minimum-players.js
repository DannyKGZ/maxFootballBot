const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const player = (userId, isReserve = false) => ({
  userId,
  displayName: `Игрок ${userId}`,
  profileName: `Игрок ${userId}`,
  isReserve,
  joinedAt: 0,
});

let kickoff;
let previous;

module.exports = {
  name: "Минимум основы: отмена, оплата, история и MVP по чатам",
  env: {
    CHAT_IDS: "-1,-2,-3,-4",
    MIN_PLAYERS: "",
    PAYMENT_HOURS_BEFORE: "1",
    PAYMENT_AMOUNT: "350",
    PAYMENT_DETAILS: "Тестовые реквизиты",
    VOTE_AUTO_START_MINUTES: "0.01",
    TICK_INTERVAL_MS: "250",
  },
  preload(dir) {
    kickoff = new Date(Date.now() + 22_000);
    previous = new Date(Date.now() - 86_400_000);
    const session = (chatId, date, players) => ({ chatId, date, players, createdAt: Date.now(), messageId: null });
    const small = [player(2), player(3), player(4)];
    const extra = Array.from({ length: 7 }, (_, i) => i + 5);
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([
      session(-1, kickoff, [...small, ...extra.map((id) => player(id, true))]),
      session(-2, kickoff, small),
      session(-3, kickoff, [...small, ...extra.map((id) => player(id))]),
      session(-4, previous, small),
    ]));
  },
  async run(t) {
    await t.say(1, "/минимум");
    t.ok(!!t.find(/для проведения игры: 10\b/), "по умолчанию нужно ровно 10 игроков основы");
    await t.say(2, "/минимум 3");
    t.ok(!!t.find(/Только для админов/), "менять порог может только администратор");
    await t.say(1, "/минимум 3", { chat: -2 });
    t.ok(!!t.find(/для проведения игры: 3\b/, -2), "порог другого чата можно снизить независимо");
    await t.say(1, "/голосование");
    t.ok(!!t.find(/когда в основе наберётся минимальный состав/) && !t.query("SELECT 1 FROM votes WHERE chat_id = -1").length,
      "три игрока основы и семь резервных не запускают MVP вручную");
    await t.say(1, "/чеки 89001112233 Получатель");
    await t.say(1, "/оплата_список");
    t.ok(!!t.find(/Оплата откроется.*минимум 10/) && !t.query("SELECT 1 FROM payments WHERE chat_id = -1").length,
      "ни таймер, ни команда не открывают оплату при недоборе");

    const db = new Database(path.join(t.dataDir, "bot.db"));
    const insert = db.prepare(`INSERT INTO payments (chat_id, game_date, payer_id, payer_name, payer_profile, players, due)
      VALUES (?, ?, 2, 'Игрок 2', 'Игрок 2', '["Игрок 2"]', 350)`);
    insert.run(-1, kickoff.toISOString());
    db.close();
    await t.say(1, "/должники все");
    t.ok(!!t.find(/Должников нет/), "старые строки открытой игры при недоборе скрыты из должников");
    t.ok(!t.find(/^💰 Оплата.*₽/) && !!t.find(/^💰 Оплата.*₽/, -2) && !!t.find(/^💰 Оплата.*₽/, -3),
      "напоминание об оплате идёт только чатам, где набрался состав");

    await t.waitFor(() => !!t.find(/не состоялась.*3 из 10/) && !!t.find(/^🏆 Голосование/, -2) && !!t.find(/^🏆 Голосование/, -3), 30_000);
    const cancellations = t.query("SELECT chat_id, game_date FROM game_cancellations");
    t.ok(cancellations.length === 1 && cancellations[0].chat_id === -1 && cancellations[0].game_date === kickoff.toISOString(),
      "автоматически отменён только матч с недобором");
    t.ok(!t.query("SELECT 1 FROM votes WHERE chat_id = -1").length && !t.query("SELECT 1 FROM match_history WHERE chat_id = -1").length,
      "после отмены нет MVP и строки в истории");
    t.ok(t.query("SELECT status FROM payments WHERE chat_id = -1")[0]?.status === "unpaid",
      "старый учёт сохранён при отмене");
    t.ok(t.query("SELECT chat_id FROM match_history ORDER BY chat_id").map((row) => row.chat_id).join(",") === "-4,-3,-2",
      "история сыгранных и прежних матчей сохраняется");
    await t.say(1, "/минимум сброс", { chat: -2 });
    await t.restartBot();
    await t.say(1, "/должники все");
    t.ok(t.count(/не состоялась.*3 из 10/) === 1 && !!t.find(/Должников нет/),
      "отмена сохраняется после перезапуска и объявляется один раз");
    t.ok(!!t.find(/^🏆 Голосование/, -2) && !!t.query("SELECT 1 FROM match_history WHERE chat_id = -2").length,
      "после смены порога подтверждённая игра остаётся сыгранной");
  },
};
