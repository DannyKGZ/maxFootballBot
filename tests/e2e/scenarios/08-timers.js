const { sleep } = require("../harness");

module.exports = {
  name: "Автозакрытие голосования",
  env: {
    VOTE_AUTO_CLOSE_HOURS: "0.0015", // ~5 секунд
    TICK_INTERVAL_MS: "300",
  },
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(1, "/голосование");
    await t.click(2, t.find(/Голосование за MVP/), "Ruslan");
    t.ok(!t.find(/^🏆 MVP матча/), "сразу голосование не закрывается");
    await sleep(6000);
    await t.idle();
    const res = t.find(/^🏆 MVP матча/);
    t.ok(res && res.text.includes("закрыто автоматически"), "через ~5 с голосование закрылось само", res && res.text);
    t.ok(!t.find(/Голосование за MVP/), "сообщение голосования удалено");
    t.ok(t.mvpCount("Ruslan") === 1, "MVP засчитан ровно один раз");
    await t.say(1, "/итоги");
    t.ok(!!t.find(/нет активного голосования/), "повторно закрыть уже закрытое нельзя");
  },
};
