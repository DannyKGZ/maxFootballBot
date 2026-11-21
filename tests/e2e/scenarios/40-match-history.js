const fs = require("node:fs");
const path = require("node:path");
const { dmOf } = require("../harness");

const now = Date.now();
const day = 86_400_000;
const player = (userId, displayName, isReserve = false) => ({ userId, displayName, isReserve, joinedAt: 0, profileName: displayName });
const session = (chatId, daysAgo, players) => ({ chatId, players, date: new Date(now - daysAgo * day).toISOString(), createdAt: 0, messageId: null });

module.exports = {
  name: "История матчей: состав, MVP, изоляция чатов, перезапуск и срок хранения",
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
    await t.say(2, "/история");
    const initial = t.find(/^📚 История матчей/).text;
    t.ok(initial.includes("🏆 MVP: нет сохранённого результата\n\nСостав (2)\n1. Руслан\n2. Рома\n\nРезерв (1)\n1. Резервный")
      && initial.includes("Старый состав"), "мигрировали прежний и текущий составы, каждый игрок показан отдельной строкой");
    t.ok(!initial.includes("Другая лига") && !t.archived(-3), "история изолирована, просроченный архив удалён");
    await t.say(1, "/голосование");
    await t.click(3, t.find(/^🏆 Голосование/), "Руслан");
    t.mock.state.failOnce.add("POST /messages");
    await t.say(1, "/итоги");
    t.ok(t.mvpCount("Руслан") === 1 && t.query("SELECT count(*) AS n FROM votes")[0].n === 0, "MVP засчитан даже при отказе публикации");
    await t.restartBot();
    await t.say(2, "/история", { dm: true });
    const history = t.find(/^📚 История матчей/, dmOf(2)).text;
    t.ok(history.includes("🏆 MVP: Руслан\n\nСостав (2)") && history.includes("Старый состав") && t.mvpCount("Руслан") === 1, "результат виден перед составом, обе игры сохранились после рестарта");
    t.ok(!!t.find(/^🏆 MVP матча/), "результат доставлен в чат после сбоя");
  },
};
