const fs = require("fs");
const path = require("path");
const { sleep, dmOf } = require("../harness");

const player = (userId, displayName) => ({ id: `p${userId}`, userId, displayName, profileName: displayName, isReserve: false, joinedAt: 0 });

module.exports = {
  name: "Автозапуск голосования после игры, автозакрытие, своё имя (/имя)",
  // Игра начинается через 2 с, голосование — через 3 с после начала (вместо 60 мин).
  env: { VOTE_AUTO_START_MINUTES: "0.05", TICK_INTERVAL_MS: "300" },
  preload(dir) {
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify([{ chatId: -1, messageId: null, createdAt: Date.now(), date: new Date(Date.now() + 2000).toISOString(), players: [player(2, "Ruslan"), player(3, "Рома")] }]),
    );
  },
  async run(t) {
    t.ok(!t.find(/Голосование за MVP/), "до конца игры голосования нет");
    await sleep(6000);
    await t.idle();
    let v = t.find(/Голосование за MVP/);
    t.ok(!!v, "голосование открылось само, без админа");
    t.ok(t.buttons(v).join("|") === "Ruslan|Рома", "без голосов на кнопках только имена — прогресс скрыт", t.buttons(v));

    await t.click(2, v, "Рома");
    v = t.find(/Голосование за MVP/);
    t.ok(t.buttons(v).join("|") === "Ruslan|Рома ▰▰▰▰▰▱▱▱▱▱ 1", "прогресс только у того, за кого голосовали", t.buttons(v));
    await t.click(3, v, "Ruslan");
    const res = t.find(/^🏆 MVP матча/);
    t.ok(res && res.text.includes("Все проголосовали — голосование закрыто автоматически"), "все проголосовали — итоги сразу, без /итоги", res && res.text);
    t.ok(!t.find(/Голосование за MVP/), "сообщение голосования убрано");
    await sleep(1000);
    await t.idle();
    t.ok(!t.find(/Голосование за MVP/), "повторно по этой игре голосование само не открывается");

    // Своё имя
    await t.botStarted(2);
    const menu = t.find(/^👋/, dmOf(2));
    await t.click(2, menu, "✏️ Изменить имя", { dm: true });
    t.ok(!!t.find(/Напишите сообщением, как вас показывать/, dmOf(2)), "кнопка — бот просит новое имя");
    await t.say(2, "Руслан Большой", { dm: true });
    t.ok(!!t.find(/Теперь в списке вы — «Руслан Большой»/, dmOf(2)), "имя сохранено");
    t.ok(t.lines(t.roster())[0] === "1. Руслан Большой", "в текущем списке строка переименована", t.lines(t.roster()));

    await t.say(3, "/имя Рома Длинный");
    t.ok(t.lines(t.roster())[1] === "2. Рома Длинный", "/имя в общем чате", t.lines(t.roster()));
    await t.say(3, "/имя");
    t.ok(!!t.find(/Сейчас в списке вы — «Рома Длинный»/), "/имя без текста — показывает текущее");

    await t.say(1, "/старт");
    await t.click(1, t.find(/Точно начать новую/), "Да, начать новую");
    await t.say(2, "+");
    t.ok(t.lines(t.roster())[0] === "1. Руслан Большой", "в новой записи «+» — уже под своим именем", t.lines(t.roster()));
    await t.click(2, menu, "✏️ Изменить имя", { dm: true });
    await t.say(2, "Рус", { dm: true });
    t.ok(t.lines(t.roster())[0] === "1. Рус", "имя можно менять сколько угодно раз");
  },
};
