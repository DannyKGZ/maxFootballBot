module.exports = {
  name: "Повторный «+» ничего не спрашивает",
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(2, "+");
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan" && !t.find(/Хотите записать другого/), "повторный «+» — без вопроса и без дубля", t.lines(t.roster()));
    await t.click(2, t.roster(), "➕ Записаться");
    t.ok(t.toast() === "Вы уже записаны" && t.lines(t.roster()).length === 1, "кнопка «Записаться» повторно — только уведомление");

    await t.say(3, "+Петя");
    await t.say(3, "+");
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan|2. Петя|3. Рома", "записал друга, потом себя — «+» записывает его самого", t.lines(t.roster()));

    await t.say(4, "+");
    await t.say(4, "-");
    t.ok(!!t.find(/Удалить из списка: Влад\?/), "«-» — вопрос с подтверждением");
  },
};
