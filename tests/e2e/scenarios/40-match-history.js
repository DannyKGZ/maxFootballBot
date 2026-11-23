const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

const now = Date.now();
const day = 86_400_000;
const player = (userId, displayName, isReserve = false) => ({ userId, displayName, isReserve, joinedAt: 0, profileName: displayName });
const session = (chatId, daysAgo, players) => ({ chatId, players, date: new Date(now - daysAgo * day).toISOString(), createdAt: 0, messageId: null });

module.exports = {
  name: "История матчей: карточки, навигация, MVP, изоляция чатов и срок хранения",
  env: { CHAT_IDS: "-1,-2,-3", TICK_INTERVAL_MS: "300" },
  preload(dir) {
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
      sessions: [
        session(-1, 2, [player(2, "Руслан"), player(3, "Рома"), player(4, "Резервный", true)]),
        session(-2, 1, [player(1, "Другая лига")]),
      ],
      archived: [
        session(-1, 9, [player(1, "Старый состав")]),
        session(-3, 200, [player(1, "Просроченный состав")]),
      ],
    }));
  },
  async run(t) {
    process.env.BOT_TOKEN = "test";
    const { matchExpiresAt } = require("../../../dist/matchHistory");
    const monthEnd = new Date(2026, 7, 31, 20, 30);
    t.ok(matchExpiresAt(monthEnd.getTime()) === new Date(2027, 1, 28, 20, 30).getTime(), "окончание 6 календарных месяцев округляется к последнему дню");
    const db = new Database(path.join(t.dataDir, "bot.db"));
    const insert = db.prepare("INSERT INTO match_history (chat_id, game_at, expires_at, roster) VALUES (-1, ?, ?, ?)");
    for (const daysAgo of [11, 12, 13, 14]) {
      const time = now - daysAgo * day;
      const roster = daysAgo === 14
        ? Array.from({ length: 60 }, (_, i) => ({ displayName: `Игрок большого состава ${i + 1}`, isReserve: i >= 15 }))
        : [{ displayName: `Состав ${daysAgo}`, isReserve: false }];
      insert.run(time, matchExpiresAt(time), JSON.stringify(roster));
    }
    db.close();
    await t.say(2, "/история");
    const list = t.find(/^📚 История матчей/);
    const view = () => t.mock.messages.get(list.mid);
    const labels = () => t.buttons(view());
    t.ok(list.text.includes("1/2") && !list.text.includes("Руслан") && labels().filter((label) => label.startsWith("⚽")).length === 5,
      "команда открывает короткий список из пяти матчей");
    t.ok(!t.archived(-3), "просроченный архив удалён");
    await t.click(2, view(), "⚽", { chat: -2 });
    t.ok(view().text.startsWith("📚 История матчей") && t.toast().includes("в нужном чате"), "кнопка не открывает состав из другого чата");
    await t.click(2, view(), "⚽");
    t.ok(view().text.includes("👥 Состав (2)\n1. Руслан\n2. Рома\n\n🪑 Резерв (1)\n1. Резервный")
      && !view().text.includes("Старый состав") && !view().text.includes("MVP"), "выбранный матч показывает только свой состав и резерв");
    await t.click(2, view(), "‹ К списку");
    await t.click(2, view(), "Дальше");
    t.ok(view().text.includes("2/2") && labels().filter((label) => label.startsWith("⚽")).length === 1,
      "следующая страница открывается в том же сообщении");
    await t.click(2, view(), "⚽");
    t.ok(view().text.includes("Игрок большого состава 1") && labels().includes("Состав ›"),
      "длинный состав можно листать в карточке");
    await t.click(2, view(), "Состав ›");
    t.ok(view().text.includes("Резерв") || view().text.includes("Игрок большого состава 16"), "следующая часть показывает продолжение состава");
    await t.click(2, view(), "‹ К списку");
    await t.click(2, view(), "‹ Назад");
    t.ok(view().text.includes("1/2") && t.count(/^📚 История матчей/) === 1, "обратная навигация не публикует новых сообщений");
    await t.say(2, "/history 2");
    t.ok(t.find(/^📚 История матчей/).text.includes("2/2"), "сохранён прямой переход по номеру страницы");
    await t.say(1, "/голосование");
    await t.click(3, t.find(/^🏆 Голосование/), "Руслан");
    t.mock.state.failOnce.add("POST /messages");
    await t.say(1, "/итоги");
    t.ok(t.mvpCount("Руслан") === 1 && t.query("SELECT count(*) AS n FROM votes")[0].n === 0, "MVP засчитан даже при отказе публикации");
    await t.restartBot();
    await t.say(2, "/история", { dm: true });
    const dm = t.find(/^📚 История матчей/, dmOf(2));
    await t.click(2, dm, "⚽", { dm: true });
    const history = t.mock.messages.get(dm.mid).text;
    t.ok(history.includes("1. Руслан — 🏆 MVP\n2. Рома") && !history.includes("MVP:")
      && !history.includes("Другая лига") && t.mvpCount("Руслан") === 1, "в личке MVP отмечен рядом с именем после рестарта");
    t.ok(!!t.find(/^🏆 MVP матча/), "результат доставлен в чат после сбоя");
  },
};
