const { dmOf } = require("../harness");

module.exports = {
  name: "/описание — шаблон шапки с автоматическими днём недели и датой",
  env: { GAME_DAY_OF_WEEK: "3", GAME_TIME: "21:30" },
  async run(t) {
    const session = () => JSON.parse(t.query("SELECT data FROM sessions WHERE chat_id = -1")[0].data);
    const hhmm = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });

    await t.say(1, "/старт");
    await t.say(2, "+");
    t.ok(/^Футбол в Среда \d\d\.\d\d\.\d{4} года\nВ 21:30/.test(t.roster().text), "стандартная шапка: 21:30");

    await t.say(4, "/описание Взлом");
    t.ok(!!t.find(/только администраторам/) && t.roster().text.startsWith("Футбол"), "не-админ не может менять шапку");
    await t.say(1, "/описание");
    t.ok(!!t.find(/Сейчас шапка записи:/), "без текста — текущая шапка и подсказка");

    // Админ пишет пример с «чужой» датой и днём — бот подставит настоящие.
    await t.say(1, "/описание Футбол в Понедельник 01.01.2024 года\nВ 20:30 - 21:30");
    const r = t.roster().text;
    t.ok(/^Футбол в Среда \d\d\.\d\d\.\d{4} года\nВ 20:30 - 21:30\n\n1\. Ruslan/.test(r), "день и дата подставлены из записи, остальной текст как написан", r);
    t.ok(!r.includes("Понедельник") && !r.includes("01.01.2024"), "пример даты из команды не попал в запись");
    t.ok(hhmm(session().date) === "20:30", "начало игры перенесено на 20:30", session().date);
    t.ok(!!t.find(/Меняется автоматически для каждой записи: день недели и дата/), "админу — что будет меняться автоматически");

    await t.say(4, "/статус");
    t.ok(t.find(/^📋 Статус записи/).text.includes("в 20:30"), "/статус считает от 20:30");

    await t.say(1, "/старт");
    await t.click(1, t.find(/Точно начать новую/), "Да, начать новую");
    t.ok(/^Футбол в Среда \d\d\.\d\d\.\d{4} года\nВ 20:30 - 21:30/.test(t.roster().text) && hhmm(session().date) === "20:30", "следующая запись — тот же шаблон, 20:30");

    await t.say(1, "/описание Игра {день} {дата_кратко}", { dm: true });
    t.ok(!!t.find(/Шапка записи обновлена/, dmOf(1)), "из лички тоже работает");
    await t.say(1, "/описание сброс");
    t.ok(/^Футбол в Среда \d\d\.\d\d\.\d{4} года\nВ 20:30\n/.test(t.roster().text), "сброс — стандартная шапка (время начала 20:30 сохранено)", t.roster().text.slice(0, 45));

    await t.restartBot();
    t.ok(t.log.includes("[server] слушаю "), "после перезапуска всё на месте");
  },
};
