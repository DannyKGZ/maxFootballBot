const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

module.exports = {
  name: "Команды по пять, лимиты 10 и 15, замены и резерв",
  teamFormat: true,
  env: { CHAT_IDS: "-1,-2", MAX_PLAYERS: "15" },
  preload(dir) {
    const session = (chatId, count) => ({
      chatId,
      date: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: Date.now(),
      messageId: null,
      players: Array.from({ length: count }, (_, index) => ({
        userId: index + 2,
        displayName: `Игрок ${index + 1}`,
        joinedAt: index,
        isReserve: false,
      })),
    });
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([session(-1, 10), session(-2, 14)]));
    const db = new Database(path.join(dir, "bot.db"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("max_players:-1", "10");
    db.close();
  },
  async run(t) {
    const session = (chat) => JSON.parse(t.query("SELECT data FROM sessions WHERE chat_id = ?", chat)[0].data);
    const draft = (chat) => t.find(/^⚽ Дележка/, chat);
    const finish = async (chat, picks) => {
      for (let i = 0; i < picks; i++) {
        const message = draft(chat);
        await t.click(1, message, t.buttons(message).find((label) => label.startsWith("Игрок")), { chat });
      }
    };
    const teamSizes = (chat) => {
      const draft = session(chat).draft;
      return draft.captains.map((_, team) => 1 + draft.picks.filter((pick) => pick.team === team).length);
    };

    await t.say(2, "+Резервист");
    await t.say(2, "/статус");
    t.ok(session(-1).players.find((player) => player.displayName === "Резервист")?.isReserve
      && !!t.find(/2 команды по 5/), "при лимите 10 одиннадцатый записанный идёт в резерв");
    await t.say(1, "/дележка");
    t.ok(draft(-1)?.text.includes("выберите 2 капитанов") && !t.buttons(draft(-1)).includes("👑 Резервист"),
      "Вершина выбирает двух капитанов из десяти игроков основы");

    await t.say(2, "/статус", { chat: -2 });
    t.ok(!!t.find(/2 команды по 5\. Игроков на замену: 4/, -2), "при 14 игроках две пятёрки и четыре замены");
    await t.say(1, "/дележка 1 2", { chat: -2 });
    await finish(-2, 8);
    let result = t.find(/^⚽ Составы готовы/, -2);
    t.ok(teamSizes(-2).join(",") === "5,5" && result?.text.includes("🔄 Замены\n1. Игрок 11\n2. Игрок 12\n3. Игрок 13\n4. Игрок 14"),
      "готовые составы делятся на две пятёрки и отдельно показывают четыре замены");

    await t.say(2, "+Пятнадцатый", { chat: -2 });
    await t.say(2, "/статус", { chat: -2 });
    t.ok(!!t.find(/3 команды по 5/, -2) && session(-2).players.filter((player) => !player.isReserve).length === 15,
      "пятнадцатый игрок автоматически даёт третью пятёрку");
    await t.say(1, "/дележка 1 2", { chat: -2 });
    t.ok(!!t.find(/Укажите 3 разных номера/, -2), "при трёх командах требуются три капитана");
    await t.say(1, "/дележка 1 2 3", { chat: -2 });
    await finish(-2, 2);
    t.ok(!!t.find(/Выбирает 🔵 Команда 3/, -2), "после двух выборов ход у третьего капитана");
    await t.restartBot();
    await finish(-2, 9);
    result = t.find(/^⚽ Составы готовы/, -2);
    t.ok(teamSizes(-2).join(",") === "5,5,5" && session(-2).draft.stage === "done" && result?.text.includes("🔵 Команда 3")
      && !result.text.includes("🔄 Замены"), "после перезапуска создались три команды по пять");
  },
};
