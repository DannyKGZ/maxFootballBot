const { dmOf } = require("../harness");
const path = require("node:path");
const Database = require("better-sqlite3");

const dateLabel = date => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric",
}).format(new Date(date));

module.exports = {
  name: "Разовая отмена матча, права, долги, перезапуск и пропуск публикации",
  env: { CHAT_IDS: "-1,-2", GAME_DAY_OF_WEEK: "3", GAME_TIME: "21:30", TIMEZONE: "Europe/Moscow" },
  async run(t) {
    const session = chatId => {
      const row = t.query("SELECT data FROM sessions WHERE chat_id = ?", chatId)[0];
      return row && JSON.parse(row.data);
    };
    await t.say(1, "/старт");
    await t.say(2, "+");
    const { date, messageId } = session(-1);
    const command = "/отменаигры " + dateLabel(date);
    await t.say(2, command);
    t.ok(!!t.find(/Только для админов/) && session(-1).date === date, "участник не может отменить матч");
    await t.say(1, "/отменаигры 31.02.2027");
    t.ok(!!t.find(/Такой даты в календаре нет/), "несуществующая дата отклонена");

    await t.say(1, "/оплата 350 Т-Банк 89990000000 Имя");
    await t.say(1, "/чеки +7 (900) 111-22-33 Мария П.");
    const db = new Database(path.join(t.dataDir, "bot.db"));
    db.prepare(`INSERT INTO payments (chat_id, game_date, payer_id, payer_name, payer_profile, players, due)
      VALUES (-1, ?, 2, 'Ruslan', 'Ruslan', '["Ruslan"]', 350)`).run(date);
    db.close();
    await t.say(1, "/должники все");
    t.ok(t.query("SELECT status FROM payments WHERE chat_id = -1 AND game_date = ?", date)[0]?.status === "unpaid", "у будущей игры уже есть строка оплаты");
    await t.say(1, "/голосование");
    t.ok(t.query("SELECT count(*) AS n FROM votes WHERE chat_id = -1")[0].n === 1, "подготовлено голосование по будущей игре");

    await t.say(1, command, { dm: true });
    await t.waitFor(() => !!t.find(/^🚫 Игра .* отменена/, dmOf(1)));
    t.ok(!session(-1) && !t.query("SELECT 1 FROM votes WHERE chat_id = -1").length &&
      t.query("SELECT game_date FROM game_cancellations WHERE chat_id = -1")[0]?.game_date === date, "отмена из лички сохраняется и снимает запись и голосование");
    const roster = t.mock.messages.get(messageId);
    t.ok(/^🚫 Игра .* отменена/.test(roster?.text) && roster.attachments.length === 0 &&
      t.count(/^🚫 Игра .* отменена/) >= 2, "список обновлён, в группе объявлена отмена");
    await t.say(1, "/оплатил 1");
    t.ok(!!t.find(/Игра для оплаты №1 отменена/), "устаревший номер оплаты защищён");
    await t.say(1, "/должники все");
    t.ok(!!t.find(/Должников нет/) && t.query("SELECT status FROM payments WHERE game_date = ?", date)[0]?.status === "unpaid",
      "отменённая игра скрыта из долгов, запись учёта сохранена");
    await t.say(1, command);
    t.ok(!!t.find(/уже отменена/), "повтор команды не меняет другие игры");

    await t.say(1, "/старт");
    const next = session(-1)?.date;
    t.ok(next && Date.parse(next) - Date.parse(date) === 7 * 86_400_000, "следующая игра того же расписания доступна");
    await t.stopBot();
    t.scenario.env.CRON_SCHEDULE = "*/2 * * * * *";
    await t.startBot();
    await t.waitFor(() => /пропускаю отменённую игру .* в чате -1/.test(t.log) && t.all(-2).some(m => /^Футбол в/.test(m.text)));
    t.ok(session(-1)?.date === next && session(-2)?.date === date, "cron пропускает игру только в целевом чате после перезапуска");

    await t.say(1, "/игры Пн 12:00 Ср 19:00, Вт 12:00 Ср 20:00");
    await t.say(1, "/отменаигры " + dateLabel(next));
    t.ok(!!t.find(/На эту дату несколько игр.*19:00.*20:00/), "для нескольких игр в одну дату требуется время");
    await t.say(1, "/отменаигры " + dateLabel(next) + " 19:00");
    const cancellations = t.query("SELECT game_date FROM game_cancellations WHERE chat_id = -1");
    t.ok(cancellations.length === 2 && cancellations.some(row => row.game_date.endsWith("T16:00:00.000Z")) && session(-1)?.date === next,
      "указанное время отменяет один матч и сохраняет другую открытую запись");
  },
};
