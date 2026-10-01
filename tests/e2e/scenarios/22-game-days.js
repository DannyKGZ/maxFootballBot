module.exports = {
  name: "День игры — на следующий день после публикации по расписанию",
  env: { CRON_SCHEDULE: "55 59 11 * * 0,2,4", GAME_TIME: "20:30" },
  async run(t) {
    const session = () => JSON.parse(t.query("SELECT data FROM sessions WHERE chat_id = -1")[0].data);
    await t.say(1, "/старт");
    const d = new Date(session().date);
    const msk = (o) => d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", ...o });
    const wd = msk({ weekday: "short" });
    t.ok(["пн", "ср", "пт"].includes(wd) && msk({ hour: "2-digit", minute: "2-digit" }) === "20:30", `публикация Вс/Вт/Чт → игра Пн/Ср/Пт в 20:30 (сейчас: ${wd} ${msk({ hour: "2-digit", minute: "2-digit" })})`);
    const gap = (d.getTime() - Date.now()) / 86_400_000;
    t.ok(gap > 0 && gap <= 3.0, "это ближайшая игра (не дальше 3 дней)", gap);

    await t.say(4, "/статус");
    const s = t.find(/^📋 Статус/).text;
    t.ok(/Следующая запись откроется (воскресенье|вторник|четверг) \d\d\.\d\d в 11:59 — на игру (понедельник|среда|пятница) \d\d\.\d\d в 20:30/.test(s), "статус: когда следующая запись и на какую игру", s.split("\n").pop());

    await t.say(1, "/расписание");
    await t.click(1, t.find(/Выберите дни/), "Чт");
    await t.click(1, t.find(/Выберите дни/), "Готово");
    await t.click(1, t.find(/Во сколько публиковать/), "Другое время");
    await t.say(1, "11:59:55");
    t.ok(!!t.find(/игра — на следующий день после публикации: Пт в 20:30/), "после /расписание бот пишет, в какие дни будут игры");
  },
};
