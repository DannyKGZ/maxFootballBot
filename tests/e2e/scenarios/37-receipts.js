const path = require("path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

const H = 3_600_000;
const ENV = {
  CHAT_IDS: "-1,-2",
  PAYMENT_HOURS_BEFORE: "0",
  PAYMENT_HOURS_AFTER: "2",
  PAYMENT_AMOUNT: "350",
  PAYMENT_DETAILS: "Т-банк +7 (900) 111-22-33, получатель Мария П.",
  TICK_INTERVAL_MS: "300",
};

module.exports = {
  name: "Оплата с PDF-чеками: проверка суммы и получателя, список, /должники, /оплатил",
  env: ENV,
  async run(t) {
    // Разбор чека (чистые функции).
    const { CHAT_IDS, ...envForDist } = ENV;
    Object.assign(process.env, envForDist, { BOT_TOKEN: "test", DOTENV_CONFIG_PATH: "/nonexistent" });
    const { findAmount, recipientMatches } = require("../../../dist/receiptLogic");
    t.ok(findAmount("Итого\n1 050 ₽\nСумма 1 050 ₽") === 1050 && findAmount("Сумма перевода 700,00 ₽") === 700 && findAmount("Итого\n350 ₽") === 350 && findAmount("без суммы") === null, "сумма из текста чека");
    const exp = { phone: "+7 (900) 111-22-33", recipient: "Мария П." };
    t.ok(recipientMatches("Телефон получателя +7 (900) 111-22-33", exp) && recipientMatches("Получатель Мария П.", exp) && !recipientMatches("Получатель Иван И. +7 (900) 000-00-00", exp), "получатель: по телефону или имени");

    // «Лига» (-2): проверка чеков включена; игра была 1,5 ч назад.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('chat_opts:-2', ?)").run(JSON.stringify({ receipts: exp, paymentBefore: 0, paymentAfter: 2 }));
    const p = (userId, displayName, extra = {}) => ({ userId, displayName, profileName: displayName, isReserve: false, joinedAt: 0, ...extra });
    const players = [p(2, "Ruslan"), p(3, "Рома"), p(4, "Влад"), p(5, "Пятый"), p(6, "Шестой"), { userId: 6, displayName: "Петя", addedByName: "Шестой", isReserve: false, joinedAt: 0 }];
    d.prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(-2, JSON.stringify({ chatId: -2, messageId: null, createdAt: 0, date: new Date(Date.now() - 1.5 * H).toISOString(), players }));
    d.close();
    await t.startBot();
    await t.idle(1500);
    const pay = () => t.find(/^💰 Оплата за игру/, -2);
    t.ok(pay() && pay().text.includes("Оплатили 0 из 5:") && pay().text.includes("Чек (PDF) — сюда в чат или боту в личку") && (pay().text.match(/max:\/\/user\//g) || []).length === 5, "список оплаты: все 5 с упоминаниями и просьбой прислать PDF", pay() && pay().text);
    t.ok(pay().text.includes('<a href="max://user/6">Шестой</a> — 700 ₽ (Шестой, Петя)'), "кто записывал друга — платит за двоих");

    // Ruslan записал себя → должен 350 ₽: PDF в личку на 350 — принят.
    await t.sendFile(2, "receipt-350.pdf");
    t.ok(/^✅ оплата 350 ₽ за игру \d\d\.\d\d принята\.$/.test(t.all(dmOf(2)).pop().text), "PDF 350 ₽ в личку — принят", t.all(dmOf(2)).pop().text);
    t.ok(pay().text.includes("✅ Ruslan — 350 ₽") && pay().text.includes("Оплатили 1 из 5:") && !pay().text.includes("max://user/2"), "список обновился, Ruslan больше не упоминается");

    // Шестой записал себя и Петю → должен 700 ₽. Чек на 1050 в общий чат — не та сумма, на проверку.
    await t.sendFile(6, "receipt-1050.pdf", "file", { chat: -2 });
    t.ok(/^🧾 Шестой: чек на ручной проверке \(сумма 1050 ₽, нужно 700 ₽ \(2 × 350 ₽\)\)/.test(t.all(-2).pop().text), "чек в чат: сумма не равна 2 × 350 — ручная проверка", t.all(-2).pop().text);
    t.ok(!t.dmTo(1).some((m) => /🧾/.test(m.text || "")), "админам в личку ничего не приходит");
    await t.sendFile(6, "receipt-700.pdf", "file", { chat: -2 });
    t.ok(/^✅ Шестой: оплата 700 ₽ за игру/.test(t.all(-2).pop().text) && pay().text.includes("✅ Шестой — 700 ₽ (Шестой, Петя)"), "PDF 700 ₽ в чат — за двоих, принят");

    // Фото чека — на ручную проверку.
    await t.sendFile(3, "photo.jpg", "image");
    t.ok(/^🧾 чек на ручной проверке \(фото/.test(t.all(dmOf(3)).pop().text) && pay().text.includes("⏳ Рома — 350 ₽ — чек на проверке") && !pay().text.includes("max://user/3"), "фото в личку — на проверку, больше не упоминаем", t.all(dmOf(3)).pop().text);
    const before = t.all(-2).length;
    await t.sendFile(5, "meme.jpg", "image", { chat: -2 });
    t.ok(t.all(-2).length === before, "фото в чате без подписи про оплату — не чек, бот молчит");
    await t.sendFile(5, "photo.jpg", "image", { chat: -2, caption: "чек" });
    t.ok(/^🧾 Пятый: чек на ручной проверке/.test(t.all(-2).pop().text), "фото с подписью «чек» в чате — на проверку");

    // Влад: тот же PDF, что у Ruslan, — повтор; затем 300 — не та сумма.
    await t.sendFile(4, "receipt-350.pdf");
    t.ok(/этот чек уже присылали/.test(t.all(dmOf(4)).pop().text), "повторный чек — на проверку");

    await t.sendFile(2, "receipt-350-b.pdf");
    t.ok(/^Неоплаченных игр нет/.test(t.all(dmOf(2)).pop().text), "всё оплачено — так и отвечает");

    // Админ запрашивает должников и чеки кнопкой в личке (панель — по «Лиге»: админ состоит только в ней).
    t.mock.state.chatMembers = { "-1": [2, 3, 4, 5, 6], "-2": [1, 2, 3, 4, 5, 6] };
    await t.botStarted(1);
    const panel = t.find(/Панель администратора/, dmOf(1));
    t.ok(panel && t.buttons(panel)[0] === "💰 Должники и чеки", "в панели «Лиги» — кнопка «💰 Должники и чеки»", panel && t.buttons(panel));
    await t.click(1, panel, "💰 Должники и чеки", { dm: true });
    const dm1 = t.dmTo(1);
    const list = dm1.find((m) => /^💰 Должники/.test(m.text || ""));
    t.ok(list && /\n1\. Рома \(Рома\)/.test(list.text), "в личке — список должников", list && list.text);
    const tokens = dm1.flatMap((m) => (m.attachments || []).map((a) => a.payload && a.payload.token)).filter(Boolean);
    t.ok(dm1.some((m) => /^🧾 1\. Рома — чек \(фото/.test(m.text || "")) && tokens.includes("img") && tokens.includes("tok-receipt-350.pdf"), "под списком — файлы чеков на проверке", tokens);

    await t.say(3, "/должники", { chat: -2 });
    t.ok(!!t.find(/Только для админов/, -2), "/должники — только админ");
    await t.say(1, "/должники", { chat: -2 });
    const debt = t.all(-2).pop().text;
    t.ok(/^💰 Должники — [а-я]+ \d{4}: 3, на 1050 ₽/.test(debt) && /\n1\. Рома \(Рома\) — 350 ₽ — \d\d\.\d\d · ⏳ чек на проверке/.test(debt), "/должники: имя (ник), сумма, дата игры, статус", debt);
    await t.say(1, "/оплатил 1 2 3", { chat: -2 });
    t.ok(/^✅ Отмечено как оплачено:\nРома \(Рома\) — 350 ₽/.test(t.all(-2).pop().text) && pay().text.includes("Оплатили 5 из 5:"), "/оплатил — наличные/проверено, список обновлён");
    await t.say(1, "/должники", { chat: -2 });
    t.ok(/^💰 Должников нет/.test(t.all(-2).pop().text), "должников нет");
    await t.say(1, "/должники");
    t.ok(/учёт оплаты .* не включён/.test(t.all().pop().text), "в первом чате учёта нет");
  },
};
