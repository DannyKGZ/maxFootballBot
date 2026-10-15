const fs = require("fs");
const path = require("path");
const { dmOf } = require("../harness");

const H = 3_600_000;

module.exports = {
  name: "/статус — актуальность записи; сброс расписания кнопкой",
  env: { MAX_PLAYERS: "3", CRON_SCHEDULE: "0 9 * * 1,5" },
  preload(dir) {
    // Запись на игру, которая уже прошла вчера (устарела, новая ещё не открыта).
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify([
        {
          chatId: -1,
          messageId: null,
          createdAt: Date.now() - 3 * 24 * H,
          date: new Date(Date.now() - 20 * H).toISOString(),
          players: [{ userId: 2, displayName: "Ruslan", isReserve: false, joinedAt: 0 }],
        },
      ]),
    );
  },
  async run(t) {
    await t.say(4, "/статус");
    let s = t.find(/^📋 (Игра |Записи нет)/);
    t.ok(!!s, "/статус доступна любому участнику");
    t.ok(s.text.includes("🔒 Запись закрыта") && s.text.includes("назад"), "прошедшая игра — запись закрыта", s.text);
    t.ok(/🗓 Следующая запись: (Пн|Пт) \d\d\.\d\d, 09:00 → игра (Вт|Сб) \d\d\.\d\d, \d\d:\d\d/.test(s.text), "показано, когда бот сам откроет новую запись и на какую игру", s.text);

    await t.say(1, "/старт");
    await t.click(1, t.find(/Точно начать новую/), "Да, начать новую");
    await t.say(2, "+");
    await t.say(3, "+Петя +Коля +Вова");
    await t.say(4, "/status");
    s = t.find(/^📋 (Игра |Записи нет)/);
    t.ok(/✅ Запись открыта, до игры \d/.test(s.text), "новая запись — открыта, сколько до игры", s.text);
    t.ok(/Основа 3\/3, мест нет:\n1\. Ruslan\n2\. Петя\n3\. Коля/.test(s.text) && /Резерв 1:\n4\. Вова/.test(s.text), "в статусе список основы и резерва", s.text);
    t.ok(t.count(/^📋 (Игра |Записи нет)/) === 1, "новый /статус заменяет старое сообщение");

    await Promise.all([2, 3, 4, 5].map((u) => t.post(t.messageUpdate(u, "/статус"))));
    await t.idle();
    t.ok(t.count(/^📋 (Игра |Записи нет)/) === 1, "4 одновременных /статус → одно сообщение");

    await t.say(5, "/статус", { dm: true });
    t.ok(!!t.find(/^📋 (Игра |Записи нет)/, dmOf(5)), "в личке с ботом /статус тоже работает");

    await t.say(1, "/закрыть");
    await t.click(1, t.find(/Точно закрыть/), "Да, закрыть");
    await t.say(4, "/статус");
    t.ok(t.find(/^📋 (Игра |Записи нет)/).text.startsWith("📋 Записи нет."), "после /закрыть — записи нет");

    // Кнопка сброса расписания в /расписание.
    await t.say(1, "/расписание");
    await t.click(1, t.find(/Выберите дни/), "Ср");
    await t.click(1, t.find(/Выберите дни/), "Готово");
    await t.click(1, t.find(/Во сколько публиковать/), "20:00");
    t.ok(t.savedSchedule().cron === "0 0 20 * * 3", "расписание сохранено");
    await t.say(1, "/расписание");
    const dlg = t.find(/Выберите дни/);
    t.ok(dlg.text.includes("Сейчас запись публикуется: Ср в 20:00 (настроено через /расписание)"), "диалог показывает действующее расписание", dlg.text);
    await t.click(2, dlg, "♻️ Сбросить");
    t.ok(t.toast().includes("не участвуете") && t.savedSchedule(), "чужая кнопка сброса не работает");
    await t.click(1, dlg, "♻️ Сбросить");
    t.ok(!t.savedSchedule(), "расписание удалено из базы");
    t.ok(!!t.find(/Расписание сброшено\. Теперь запись публикуется Пн, Пт в 09:00 \(по умолчанию из \.env\)/), "сообщение о сбросе");
    t.ok(t.log.includes('[scheduler] чат -1: запись по расписанию "0 9 * * 1,5"'), "планировщик сразу переключён на расписание из .env");
    await t.say(4, "/статус");
    t.ok(t.find(/^📋 (Игра |Записи нет)/).text.includes(", 09:00 → игра"), "/статус после сброса — следующая запись по расписанию из .env");
  },
};
