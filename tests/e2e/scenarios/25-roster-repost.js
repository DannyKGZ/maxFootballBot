module.exports = {
  name: "После «+» / «-» свежий список сразу внизу чата",
  env: { MAX_PLAYERS: "2" },
  async run(t) {
    const last = () => t.all().slice(-1)[0];
    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(5, "болтовня в чате");
    await t.say(6, "ещё сообщение");
    await t.say(3, "+");
    t.ok(last().text.startsWith("Футбол в") && t.lines(last()).length === 2, "после «+» список — последнее сообщение в чате");
    t.ok(t.count(/^Футбол в/) === 1, "старое сообщение со списком убрано — в чате один список");

    await t.say(4, "+Вова"); // резерв
    await t.say(5, "болтовня");
    await t.say(2, "-");
    await t.click(2, t.find(/Удалить из списка: Ruslan\?/), "Да");
    const msgs = t.all();
    t.ok(msgs[msgs.length - 1].text.startsWith("Футбол в") && /Вова.*переходит из резерва/.test(msgs[msgs.length - 2].text), "после «-»: сначала кто поднялся из резерва, последним — свежий список", msgs.slice(-2).map((m) => m.text.slice(0, 30)));
    t.ok(t.count(/^Футбол в/) === 1 && t.lines(last()).join("|") === "1. Рома (Рома)|2. Вова", "в чате один актуальный список", t.lines(last()));

    await t.say(1, "/переименовать 2 Владимир");
    const tail = t.all().slice(-2);
    t.ok(tail[0].text.startsWith("Футбол в") && t.lines(tail[0])[1] === "2. Владимир" && tail[1].text.startsWith("✅"), "правка админом — свежий список внизу, за ним подтверждение админу", tail.map((m) => m.text.slice(0, 25)));
    await t.say(1, "/описание Футбол в {День} {дата}\nВ 20:30");
    t.ok(t.count(/^Футбол в/) === 1, "смена шапки обновляет список на месте, без нового сообщения");
  },
};
