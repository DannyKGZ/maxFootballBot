const { sleep } = require("../harness");

module.exports = {
  name: "Идущие дележка и голосование держатся внизу (без уведомлений); оплата в составах; до 3 MVP",
  env: { MAX_PLAYERS: "6", STICKY_DELAY_MS: "300", PAYMENT_AMOUNT: "350", PAYMENT_DETAILS: "Т-банк 0000" },
  async run(t) {
    const settle = async () => {
      await sleep(400);
      await t.idle();
    };
    const last = () => t.all().slice(-1)[0];

    await t.say(1, "/старт");
    for (const uid of [2, 3, 4, 5, 6]) await t.say(uid, "+");
    await t.say(2, "+Петя");
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan|2. Рома|3. Влад|4. Пятый|5. Шестой|6. Петя", "в списке нет имён в скобках", t.lines(t.roster()));

    await t.say(1, "/дележка 1 2");
    await settle();
    t.ok(/^⚽ Дележка/.test(last().text), "дележка внизу");
    await t.say(5, "болтовня");
    await settle();
    t.ok(/^⚽ Дележка/.test(last().text) && t.count(/^⚽ Дележка/) === 1, "после сообщения в чате дележка снова внизу, старая удалена");
    t.ok(last().notify === false, "перепост — без уведомления");

    while (t.find(/^⚽ Дележка/)) {
      const d = t.find(/^⚽ Дележка/);
      await t.click(1, d, t.buttons(d)[0]);
    }
    await settle();
    const done = t.find(/^⚽ Составы готовы/);
    t.ok(done && done.format === "html" && done.text.includes("💰 За игру 350 ₽ с игрока на Т-банк 0000"), "в составах — напоминание об оплате", done && done.text);
    t.ok(done && done.text.includes('<a href="max://user/2">Ruslan</a> — 700 ₽ (Ruslan, Петя)') && done.text.includes('<a href="max://user/6">Шестой</a> — 350 ₽'), "игроки отмечены (упоминания) с суммой", done && done.text);

    // Составы готовы — больше не держим их внизу (иначе бот перепостил бы их на каждое сообщение).
    const doneMid1 = done.mid;
    await t.say(9, "+"); // 7-й — в резерв
    await t.say(5, "болтовня");
    await settle();
    t.ok(/^Футбол в/.test(last().text) && t.find(/^⚽ Составы готовы/).mid === doneMid1, "готовые составы не перепубликуются");

    // Голосование: теперь внизу держится оно.
    await t.say(1, "/голосование");
    await t.say(3, "привет");
    await settle();
    t.ok(/^🏆 Голосование/.test(last().text) && t.count(/^⚽ Составы готовы/) === 1, "во время голосования внизу — голосование");

    // У всех по одному голосу → ничья у шестерых, MVP — первые трое, кто набрал голос.
    const vote = async (uid, name) => t.click(uid, t.find(/^🏆 Голосование/), name);
    await vote(2, "Рома");
    await vote(2, "Влад");
    await vote(3, "Пятый");
    await vote(4, "Шестой");
    await vote(5, "Петя");
    await vote(6, "Ruslan");
    await settle();
    const res = t.find(/^🏆 MVP матча/);
    t.ok(res && res.text.includes("MVP матча (3): Рома, Влад, Пятый — по 1 голос"), "до 3 MVP: при ничьей — первые трое", res && res.text);
    const cg = res ? res.text.split("\n").filter((l) => l.startsWith("🎉 ")) : [];
    t.ok(cg.length === 3 && cg[0].startsWith("🎉 Рома! ") && cg[1].startsWith("🎉 Влад! ") && new Set(cg.map((l) => l.replace(/^🎉 \S+! /, ""))).size === 3, "каждому MVP — своё случайное поздравление", cg);
    t.ok(t.mvpCount("Рома") === 1 && t.mvpCount("Пятый") === 1 && t.mvpCount("Шестой") === 0, "в рейтинг засчитано троим");
    t.ok(t.count(/^⚽ Составы готовы/) === 1, "после итогов составы не удалены");

    const before = t.all().length;
    const doneMid = t.find(/^⚽ Составы готовы/).mid;
    await t.say(4, "спасибо за игру");
    await settle();
    t.ok(t.all().length === before && t.find(/^⚽ Составы готовы/).mid === doneMid, "после голосования внизу больше ничего не держим");
  },
};
