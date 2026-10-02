const fs = require("fs");
const path = require("path");

// Игра прошла позавчера, запись с игроками всё ещё текущая.
const PLAYED = new Date(Date.now() - 2 * 86_400_000).toISOString();

module.exports = {
  name: "Голосование по прошедшей игре после открытия новой записи",
  preload(dir) {
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify([
        {
          chatId: -1,
          messageId: "mid.old",
          date: PLAYED,
          createdAt: 0,
          players: [
            { userId: 2, displayName: "Сыгравший", isReserve: false, joinedAt: 0 },
            { userId: 3, displayName: "Тоже играл", isReserve: false, joinedAt: 0 },
          ],
        },
      ]),
    );
  },
  async run(t) {
    await t.say(1, "/старт");
    await t.click(1, t.find(/Точно начать новую/), "Да, начать новую");
    const fresh = t.roster();
    t.ok(fresh && t.lines(fresh).length === 0, "новая запись открыта (старый формат файла прочитан)");
    await t.say(4, "+Новичок");

    await t.say(1, "/голосование");
    const v = t.find(/Голосование за MVP/);
    t.ok(t.buttons(v).join("|") === "Сыгравший|Тоже играл|📊 Посмотреть итоги", "кандидаты — из прошедшей игры, а не из новой записи", t.buttons(v));
    await t.click(4, v, "Сыгравший");
    t.ok(t.toast().includes("только тот, кто был записан"), "записанный только в новую запись за прошлую игру не голосует");
    await t.click(2, t.find(/Голосование за MVP/), "Тоже играл");
    await t.say(1, "/итоги");
    t.ok(!!t.find(/Победитель: Тоже играл/), "итог по прошедшей игре");
    t.ok(!!t.roster(), "текущая запись не удалена очисткой");
    t.ok(t.archived().players.length === 2, "прошлая игра лежит в архиве (база)");
    t.ok(t.fileExists("sessions.json.migrated") && !t.fileExists("sessions.json"), "старый JSON перенесён в базу и переименован");
  },
};
