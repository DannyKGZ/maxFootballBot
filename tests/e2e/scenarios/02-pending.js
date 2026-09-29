const { sleep } = require("../harness");

module.exports = {
  name: "Вопросы бота: команды не считаются именем, устаревшие вопросы забываются",
  env: { PENDING_TTL_MINUTES: "0.05" }, // 3 секунды
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(2, "+");
    await t.click(2, t.find(/Хотите записать другого/), "Да");
    t.ok(!!t.find(/Напишите имя нового игрока/), "«Да» → бот просит имя");
    await t.say(2, "+Петя +Коля");
    t.ok(t.lines(t.roster()).length === 3, "«+Петя +Коля» во время вопроса — обычная запись, не имя", t.lines(t.roster()));

    await t.say(2, "+");
    await t.click(2, t.find(/Хотите записать другого/), "Да");
    await t.say(2, "Валера");
    t.ok(t.lines(t.roster()).some((l) => l.includes("Валера")), "ответ на вопрос — имя добавлено");

    await t.say(2, "+");
    await t.click(2, t.find(/Хотите записать другого/), "Да");
    await sleep(3500);
    await t.say(2, "Опоздавший");
    t.ok(!t.lines(t.roster()).some((l) => l.includes("Опоздавший")), "через 3 с вопрос забыт — сообщение не стало записью");
  },
};
