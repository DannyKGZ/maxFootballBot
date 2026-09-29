const fs = require("fs");
const path = require("path");

// Данные в том виде, в каком они лежали у бота до перехода на SQLite.
module.exports = {
  name: "Перенос старых JSON-данных в SQLite",
  preload(dir) {
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        version: 2,
        sessions: [{ chatId: -1, messageId: "mid.x", date: "2030-01-01T18:30:00Z", createdAt: 0, players: [{ userId: 2, displayName: "Ruslan", isReserve: false, joinedAt: 0 }] }],
        archived: [{ chatId: -1, messageId: "mid.y", date: "2020-01-01T18:30:00Z", createdAt: 0, players: [{ userId: 3, displayName: "Рома", isReserve: false, joinedAt: 0 }] }],
        votes: [],
        pending: [],
        sent: { "-1": ["mid.a", "mid.b"] },
        ratingMessages: {},
      }),
    );
    fs.writeFileSync(path.join(dir, "schedule.json"), JSON.stringify({ cron: "0 12 * * 0,2,4", days: [2, 4, 0], time: "12:00" }));
    fs.writeFileSync(path.join(dir, "mvp.json"), JSON.stringify({ "-1": { "рус": { name: "Рус", count: 1 } } }));
  },
  async run(t) {
    t.ok(t.log.includes("данные из JSON перенесены"), "при старте данные перенесены", t.log.split("\n")[0]);
    t.ok(t.log.includes('"0 12 * * 0,2,4"'), "сохранённое расписание подхватилось (Вс, Вт, Чт 12:00)");
    t.ok(["sessions", "schedule", "mvp"].every((f) => t.fileExists(`${f}.json.migrated`) && !t.fileExists(`${f}.json`)), "JSON-файлы переименованы в *.migrated");
    t.ok(t.mvpCount("Рус") === 1, "рейтинг перенесён");
    t.ok(t.query("SELECT count(*) n FROM sent_messages")[0].n === 2, "список сообщений для очистки перенесён");
    await t.say(2, "/mvp");
    t.ok(t.find(/^🏆 Рейтинг MVP/).text.includes("Рус — 1"), "/mvp показывает перенесённый рейтинг");
    await t.say(3, "+");
    t.ok(t.query("SELECT data FROM sessions WHERE chat_id = -1")[0].data.includes("Рома"), "запись продолжает работать и пишется в базу");

    await t.restartBot();
    t.ok(!t.log.includes("данные из JSON перенесены"), "повторного переноса нет");
    t.ok(t.lines(t.roster()).length === 2, "после перезапуска список из базы на месте", t.lines(t.roster()));
  },
};
