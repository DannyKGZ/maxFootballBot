const { sleep } = require("../harness");

module.exports = {
  name: "Расписание: публикация закрывает старую запись, диалог настройки",
  env: { CRON_SCHEDULE: "*/4 * * * * *" }, // каждые 4 секунды
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+");
    const first = t.roster();
    await sleep(4500);
    await t.idle();
    const old = t.mock.messages.get(first.mid);
    t.ok(old.text.includes("— Запись закрыта, открыта новая —") && old.attachments.length === 0, "по расписанию старая запись закрыта, кнопки сняты", old.text);
    t.ok(t.count(/^Футбол в/) >= 2 && t.lines(t.roster()).length === 0, "открыта новая пустая запись");
    t.ok(t.archived().players[0].displayName === "Ruslan", "старая запись с игроком ушла в архив");

    await t.say(9, "/расписание");
    t.ok(!t.find(/Выберите дни/), "не-админ не открывает настройку расписания");
    await t.say(1, "/расписание");
    await t.click(1, t.find(/Выберите дни/), "Пн");
    await t.click(1, t.find(/Выберите дни/), "Ср");
    await t.click(1, t.find(/Выберите дни/), "✅ Пн");
    t.ok(t.find(/Выберите дни/).text.includes("Выбрано: Ср"), "повторное нажатие снимает день");
    await t.click(2, t.find(/Выберите дни/), "Готово");
    t.ok(t.toast().includes("не участвуете"), "чужие кнопки диалога не работают");
    await t.click(1, t.find(/Выберите дни/), "Готово");
    await t.click(1, t.find(/Во сколько публиковать/), "Другое время");
    await t.say(1, "25:99");
    t.ok(!!t.find(/Такого времени не бывает/), "неверное время отклонено");
    await t.say(1, "20:30:15");
    t.ok(t.savedSchedule().cron === "15 30 20 * * 3" && t.savedSchedule().time === "20:30:15", "ЧЧ:ММ:СС: сохранено cron 15 30 20 * * 3", t.savedSchedule());
    t.ok(!!t.find(/Расписание сохранено: Ср в 20:30:15/), "подтверждение с секундами");
    const rosters = t.count(/^Футбол в/);
    await sleep(5000);
    t.ok(t.count(/^Футбол в/) === rosters, "старое расписание (каждые 4 с) остановлено");
  },
};
