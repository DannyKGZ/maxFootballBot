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
  teamFormat: true,
  env: {
    CHAT_IDS: "-1,-2,-3,-4",
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
    const main = Array.from({ length: 15 }, (_, i) => player(i + 2));
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([
      session(-1, kickoff, [...main.slice(0, 9), player(50, true)]),
      session(-2, kickoff, main.slice(0, 10)),
      session(-3, kickoff, main),
      session(-4, previous, main.slice(0, 3)),
    ]));
  },
  async run(t) {
    await t.say(2, "/минимум");
    t.ok(!!t.find(/Для игры нужно 10.*две команды по 5/), "нужны две полные команды по пять игроков основы");
    await t.say(1, "/минимум 3");
    t.ok(!!t.find(/Для игры нужно 10/), "старый аргумент команды не уменьшает размер двух команд");
    await t.say(1, "/голосование");
    t.ok(!!t.find(/когда в основе наберётся минимальный состав/) && !t.query("SELECT 1 FROM votes WHERE chat_id = -1").length,
      "девять игроков основы и один резервный не запускают MVP вручную");
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

    await t.waitFor(() => !!t.find(/не состоялась.*9 из 10/) && !!t.find(/^🏆 Голосование/, -2) && !!t.find(/^🏆 Голосование/, -3), 30_000);
    const cancellations = t.query("SELECT chat_id, game_date FROM game_cancellations");
    t.ok(cancellations.length === 1 && cancellations[0].chat_id === -1 && cancellations[0].game_date === kickoff.toISOString(),
      "автоматически отменён только матч с недобором");
    await t.say(2, "/история");
    const cancelled = t.query("SELECT roster, mvp, expires_at, cancellation_reason FROM match_history WHERE chat_id = -1")[0];
    const snapshot = JSON.parse(cancelled?.roster ?? "[]");
    t.ok(!t.query("SELECT 1 FROM votes WHERE chat_id = -1").length && cancelled?.mvp === null && cancelled?.cancellation_reason === "not_enough_players"
      && snapshot.length === 10 && snapshot.filter(player => !player.isReserve).length === 9,
      "после отмены в истории сохранён полный список с резервом, без MVP");
    const history = t.find(/^📚 История матчей/);
    t.ok(history?.text.includes("Игра отменена. Состав не собрался (в основе 9)") && history.text.includes("1. Игрок 2")
      && history.text.includes("🪑 Резерв (1)") && history.text.includes("1. Игрок 50"),
      "в истории есть причина и имена столбиком");
    t.ok(t.query("SELECT status FROM payments WHERE chat_id = -1")[0]?.status === "unpaid",
      "старый учёт сохранён при отмене");
    t.ok(t.query("SELECT chat_id FROM match_history WHERE cancellation_reason IS NULL ORDER BY chat_id").map((row) => row.chat_id).join(",") === "-4,-3,-2",
      "история сыгранных и прежних матчей сохраняется");
    t.ok(cancelled?.expires_at > kickoff.getTime() + 178 * 86_400_000 &&
      cancelled?.expires_at < kickoff.getTime() + 185 * 86_400_000, "у отменённого матча срок хранения шесть календарных месяцев");
    await t.restartBot();
    await t.say(1, "/должники все");
    t.ok(t.count(/не состоялась.*9 из 10/) === 1 && !!t.find(/Должников нет/),
      "отмена сохраняется после перезапуска и объявляется один раз");
  },
};
