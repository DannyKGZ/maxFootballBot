const { sleep } = require("../harness");

module.exports = {
  name: "Зависший запрос к MAX не останавливает бота (таймауты, polling)",
  env: { UPDATES_MODE: "polling", MAX_REQUEST_TIMEOUT_MS: "1500" },
  async run(t) {
    await t.say(1, "/старт");

    // MAX «зависает» на списке участников во время /Всем.
    t.mock.state.hangOnce.add("/chats/-1/members");
    const started = Date.now();
    await t.post(t.messageUpdate(1, "/Всем тест"));
    await t.post(t.messageUpdate(2, "+"));
    await t.idle(2500);
    const took = (Date.now() - started) / 1000;
    t.ok(t.log.includes("нет ответа за 1.5 с"), "зависший запрос оборван по таймауту", t.log.split("\n").filter((l) => l.includes("members")).slice(-2));
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan (Ruslan)" && took < 10, `следующая команда обработана без многоминутной паузы (${took.toFixed(1)} с)`, t.lines(t.roster()));

    await t.say(1, "/Всем после сбоя");
    t.ok(!!t.find(/^📢 после сбоя/), "после сбоя /Всем снова работает");

    // Событие, которое MAX отдал с большим опозданием, — в логе будет видно.
    const late = t.messageUpdate(3, "+");
    late.timestamp = Date.now() - 120_000;
    late.message.timestamp = late.timestamp;
    await t.post(late);
    await t.idle();
    await sleep(200);
    t.ok(/пришло с опозданием 1\d\d с/.test(t.log), "в логе — предупреждение о позднем событии (чтобы видеть задержки MAX)");
  },
};
