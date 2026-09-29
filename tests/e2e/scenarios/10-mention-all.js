const { dmOf, GROUP } = require("../harness");

module.exports = {
  name: "/Всем — упоминание всех участников чата (с копией в личку, ANNOUNCE_DM=true)",
  env: { ANNOUNCE_DM: "true" },
  async run(t) {
    await t.say(4, "/Всем тест");
    t.ok(!!t.find(/только администраторам/) && !t.find(/^📢/), "не-админ не может /Всем");
    await t.say(1, "/Всем");
    t.ok(!!t.find(/Напишите текст после команды/), "без текста — подсказка");

    await t.say(1, "/Всем Сбор сегодня в 21:00 <не опаздывать>");
    const m = t.find(/^📢/);
    t.ok(m && m.format === "html", "сообщение с упоминаниями (html)");
    t.ok(m && m.text.startsWith("📢 Сбор сегодня в 21:00 &lt;не опаздывать&gt;"), "текст админа экранирован", m && m.text);
    const ids = m ? [...m.text.matchAll(/max:\/\/user\/(\d+)/g)].map((x) => Number(x[1])) : [];
    t.ok(ids.sort((a, b) => a - b).join(",") === "1,2,3,4,5,6,9", "упомянуты все участники чата", ids);
    t.ok(!ids.includes(777), "бот не упоминается");
    t.ok(m.text.includes('<a href="max://user/3">Рома Власенко</a>') && m.text.includes('<a href="max://user/2">Ruslan</a>'), "в ссылке полное имя из профиля (с фамилией), иначе MAX не упоминает", m.text);

    const dms = [...t.mock.messages.values()].filter((x) => x.user && x.text.startsWith("📢 Объявление из чата футбола от Админ"));
    t.ok(dms.map((x) => x.user).sort((a, b) => a - b).join(",") === "2,3,4,5,6", "копия в личку всем, кроме автора и не открывавшего бота", dms.map((x) => x.user));
    t.ok(dms[0] && dms[0].text.endsWith("Сбор сегодня в 21:00 <не опаздывать>"), "в личке — текст объявления как есть", dms[0] && dms[0].text);
    const report = t.dmTo(1).filter((x) => x.text.startsWith("📬")).pop();
    t.ok(report && report.text.includes("доставлено 5 из 6") && report.text.includes("Чужой"), "автору — итог: доставлено 5 из 6, кто не получил", report && report.text);

    await t.say(1, "@all");
    t.ok(!!t.find(/^📢 Внимание всем!/), "«@all» без текста — как в телеге, «Внимание всем!»");
    await t.say(1, "@всем Игра переносится на 22:00");
    t.ok(!!t.find(/^📢 Игра переносится на 22:00/), "«@всем текст» работает");
    await t.say(4, "@all спам");
    t.ok(!t.find(/^📢 спам/) && !!t.find(/только администраторам/), "«@all» от не-админа — отказ");

    await t.say(1, "/all проверка", { dm: true });
    t.ok(!!t.find(/^📢 проверка/) && t.find(/^📢 проверка/).chat === GROUP, "из лички админа — в общий чат");
    t.ok(!!t.find(/Отправлено в общий чат/, dmOf(1)), "в личку — подтверждение");

    t.mock.state.members = Array.from({ length: 300 }, (_, i) => ({ user_id: 10_000 + i, first_name: `Игрок${i}` }));
    await t.say(1, "/Всем много людей");
    const parts = t.all().filter((m) => m.text.includes("max://user/1") && m.text.includes("Игрок"));
    const total = parts.reduce((n, m) => n + (m.text.match(/max:\/\/user\//g) || []).length, 0);
    t.ok(parts.length > 1 && parts.every((m) => m.text.length <= 4000) && total === 300, `300 участников (3 страницы списка) → ${parts.length} сообщения, каждое ≤ 4000 символов`, { parts: parts.length, total });
  },
};
