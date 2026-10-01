const fs = require("fs");
const path = require("path");
const { sleep, dmOf } = require("../harness");

module.exports = {
  name: "Запись ведётся до начала игры, потом закрывается",
  env: { TICK_INTERVAL_MS: "300", MAX_PLAYERS: "10" },
  preload(dir) {
    // Игра начнётся через 6 секунд.
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify([{ chatId: -1, messageId: null, createdAt: Date.now(), date: new Date(Date.now() + 6000).toISOString(), players: [] }]),
    );
  },
  async run(t) {
    await t.say(2, "+");
    await t.say(3, "+");
    t.ok(t.lines(t.roster()).length === 2, "до начала игры записываются");
    await t.say(4, "/статус");
    t.ok(t.find(/^📋 Статус/).text.includes("✅ Запись открыта до начала игры"), "статус: запись открыта");

    await sleep(6500);
    await t.idle();
    const r = t.roster();
    t.ok(r.text.includes("🔒 Запись закрыта — игра началась.") && r.attachments.length === 0, "в момент начала игры сообщение записи закрыто, кнопки сняты", r.text);

    await t.say(4, "+");
    t.ok(t.lines(t.roster()).length === 2 && !!t.find(/закрыта — игра уже началась/), "«+» после начала — отказ, список не меняется");
    await t.say(3, "-");
    t.ok(t.lines(t.roster()).length === 2, "«-» после начала тоже не меняет список");
    await t.botStarted(4);
    await t.click(4, t.find(/^👋/, dmOf(4)), "➕ Записаться", { dm: true });
    t.ok(t.toast().includes("Запись закрыта") && t.lines(t.roster()).length === 2, "кнопка «Записаться» в личке — отказ");
    await t.say(4, "/статус");
    t.ok(t.find(/^📋 Статус/).text.includes("🔒 Запись закрыта — игра началась"), "статус: закрыта, игра началась");

    await t.say(1, "/удалить 1");
    t.ok(t.lines(t.roster()).length === 1 && t.roster().attachments.length === 0, "админ может поправить состав и после начала (кнопки не возвращаются)");
  },
};
