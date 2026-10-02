module.exports = {
  name: "Голосование: только основа — резерв не кандидат и не голосует",
  env: { MAX_PLAYERS: "3" },
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+"); // 1. Ruslan
    await t.say(3, "+"); // 2. Рома
    await t.say(2, "+Петя"); // 3. Петя — основа (у Ruslan две записи в основе)
    await t.say(2, "+Запасной"); // 4 — резерв Ruslan
    await t.say(4, "+"); // 5. Влад — резерв
    await t.say(1, "/голосование");
    const v = t.find(/Голосование за MVP/);
    t.ok(t.buttons(v).join("|") === "Ruslan|Рома|Петя|📊 Посмотреть итоги", "кандидаты — только основа (3), без резерва", t.buttons(v));
    t.ok(v.text.includes("Отдано голосов: 0 из 3"), "всего голосов = игроков основы", v.text);

    await t.click(4, v, "Рома");
    t.ok(t.toast().includes("только тот, кто был записан"), "резервист (Влад) не голосует");
    await t.click(2, t.find(/Голосование за MVP/), "Рома");
    await t.click(2, t.find(/Голосование за MVP/), "Петя");
    await t.click(2, t.find(/Голосование за MVP/), "Рома");
    t.ok(t.toast().includes("закончились"), "у Ruslan 2 голоса (2 записи в основе), запасной в резерве голоса не даёт");
    await t.click(3, t.find(/Голосование за MVP/), "Рома");
    const text = t.find(/Голосование за MVP/).text;
    t.ok(text.includes("Отдано голосов: 3 из 3") && text.includes("Рома ▰▰▰▰▰▰▰▱▱▱ 2") && text.includes("Петя ▰▰▰▱▱▱▱▱▱▱ 1"), "бары на шкале из 3 голосов", text);
  },
};
