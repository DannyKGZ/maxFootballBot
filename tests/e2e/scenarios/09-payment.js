const fs = require("fs");
const path = require("path");
const { sleep } = require("../harness");

const H = 3_600_000;
const at = (offset) => new Date(Date.now() + offset).toISOString();
const player = (userId, displayName, extra = {}) => ({ userId, displayName, isReserve: false, joinedAt: 0, ...extra });

const ENV = {
  REMINDER_HOURS_BEFORE: "5",
  PAYMENT_HOURS_BEFORE: "3",
  PAYMENT_HOURS_AFTER: "2",
  PAYMENT_AMOUNT: "350",
  PAYMENT_DETAILS: "💳 Сбер 0000000000",
  TICK_INTERVAL_MS: "300",
};

module.exports = {
  name: "Напоминание за 5 ч и оплата каждый час до/после игры (с упоминаниями)",
  env: ENV,
  preload(dir) {
    // Три чата в разные моменты относительно игры (формат старого JSON — заодно проверка переноса).
    const sessions = [
      {
        chatId: -1, // до игры 2,5 ч → пора первое напоминание об оплате (за 3 ч)
        messageId: null,
        createdAt: 0,
        date: at(2.5 * H),
        players: [
          player(2, "Ruslan", { profileName: "Ruslan" }),
          player(2, "Тест1", { addedByName: "Ruslan" }),
          player(3, "Рома", { profileName: "Рома" }),
          player(4, "Влад", { profileName: "Влад", isReserve: true }),
          player(5, "Друг Пятого", { addedByName: "Никита", addedByFullName: "Никита Халиманов" }),
        ],
      },
      { chatId: -2, messageId: null, createdAt: 0, date: at(4.6 * H), players: [player(2, "Ruslan", { profileName: "Ruslan" })] },
      { chatId: -3, messageId: null, createdAt: 0, date: at(-1.5 * H), players: [player(3, "Рома", { profileName: "Рома" })] },
    ];
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ version: 2, sessions }));
  },
  async run(t) {
    await sleep(1200);
    await t.idle();

    const pay = t.all(-1).filter((m) => m.text.startsWith("💰"));
    t.ok(pay.length === 1, "до игры 2,5 ч: одно напоминание об оплате", pay.map((m) => m.text));
    const p = pay[0];
    t.ok(p && p.format === "html" && p.text.includes("(до игры 3 ч)"), "формат html, слот «за 3 ч»", p && p.text);
    t.ok(p && p.text.includes('<a href="max://user/2">Ruslan</a> — 700 ₽ (Ruslan, Тест1)'), "Ruslan упомянут, 700 ₽ за себя и друга", p && p.text);
    t.ok(p && p.text.includes('<a href="max://user/3">Рома</a> — 350 ₽') && !p.text.includes("max://user/4"), "Рома — 350 ₽; резерв (Влад) не платит", p && p.text);
    t.ok(p && p.text.includes("За игру 350 ₽ с игрока на 💳 Сбер 0000000000"), "сумма и реквизиты");
    t.ok(p && p.text.includes('<a href="max://user/5">Никита Халиманов</a> — 350 ₽ (Друг Пятого)'), "записавший только друга упомянут полным именем", p && p.text);
    t.ok(!t.all(-1).some((m) => m.text.startsWith("⏰")), "напоминание за 5 ч уже опоздало на 2,5 ч — не шлём пачкой");

    t.ok(t.all(-2).some((m) => m.text.startsWith("⏰")) && !t.all(-2).some((m) => m.text.startsWith("💰")), "за 4,6 ч до игры: напоминание есть, оплаты ещё нет");
    const after = t.all(-3).filter((m) => m.text.startsWith("💰"));
    t.ok(after.length === 1 && after[0].text.includes("игра прошла"), "через 1,5 ч после игры: одно напоминание «игра прошла»", after.map((m) => m.text));

    await t.restartBot();
    await sleep(1200);
    await t.idle();
    t.ok(t.count(/^💰/, -1) === 1 && t.count(/^💰/, -3) === 1 && t.count(/^⏰/, -2) === 1, "после перезапуска уведомления не повторяются");

    // Расписание слотов во времени — чистой функцией из dist (без ожидания часами).
    Object.assign(process.env, ENV, { BOT_TOKEN: "test", DOTENV_CONFIG_PATH: "/nonexistent" });
    const { dueNotifications } = require("../../../dist/notifications");
    const game = Date.parse("2026-10-07T18:30:00Z");
    const s = { chatId: 1, messageId: null, createdAt: 0, date: new Date(game).toISOString(), players: [player(1, "A")] };
    const step = (now) => {
      const r = dueNotifications(s, now);
      s.notified = [...new Set([...(s.notified || []), ...r.mark])];
      return r.send.map((x) => x.key).join(",");
    };
    const seq = [-5, -3, -2, -1, 0.5, 1, 2, 3].map((h) => `${h}ч:${step(game + h * H + 60_000) || "—"}`);
    t.ok(seq.join(" ") === "-5ч:reminder -3ч:pay-3 -2ч:pay-2 -1ч:pay-1 0.5ч:— 1ч:pay+1 2ч:pay+2 3ч:—", "за 5 ч напоминание; оплата −3, −2, −1, +1, +2 ч", seq.join(" "));
    const s2 = { ...s, notified: [] };
    const late = dueNotifications(s2, game + 1.2 * H);
    t.ok(late.send.map((x) => x.key).join(",") === "pay+1" && late.mark.length === 5, "после простоя шлётся только последнее, остальные отмечены", late);
  },
};
