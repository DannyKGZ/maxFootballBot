const { dmOf } = require("../harness");

module.exports = {
  name: "/поменять 1 на 12 — админ меняет игроков местами",
  env: { MAX_PLAYERS: "2" },
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+"); // 1. Ruslan
    await t.say(3, "+"); // 2. Рома
    await t.say(4, "+"); // 3. Влад — резерв
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan|2. Рома|3. Влад (Резерв)", "исходный список");

    await t.say(4, "/поменять 1 на 3");
    t.ok(!!t.find(/только администраторам/) && t.lines(t.roster())[0].startsWith("1. Ruslan"), "не-админ не может менять местами");

    await t.say(1, "/поменять 1 на 3");
    t.ok(t.lines(t.roster()).join("|") === "1. Влад|2. Рома|3. Ruslan (Резерв)", "резервист в основе, первый — в резерве", t.lines(t.roster()));
    t.ok(!!t.find(/Поменял местами: Ruslan теперь №3 \(в резерве\), Влад — №1 \(в основе\)/), "админу — кто куда переместился");
    const tail = t.all().slice(-2);
    t.ok(tail[0].text.startsWith("Футбол в") && t.count(/^Футбол в/) === 1, "свежий список внизу, в чате он один");

    await t.say(1, "/поменять 2 3");
    t.ok(t.lines(t.roster())[1] === "2. Ruslan", "работает и без «на»");
    await t.say(1, "/поменять 1 на 9");
    t.ok(!!t.find(/Укажите два разных номера из списка \(1–3\)/), "номер вне списка — подсказка");
    await t.say(1, "/поменять 2 на 1", { dm: true });
    t.ok(!!t.find(/Поменял местами/, dmOf(1)) && t.lines(t.roster())[0].startsWith("1. Ruslan"), "из лички — тоже работает");
  },
};
