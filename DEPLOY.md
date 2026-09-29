# Запуск бота на Timeweb Cloud

Инструкция, как перенести бота с ПК на облачный сервер Timeweb Cloud, чтобы он
работал круглосуточно без вашего компьютера и без туннеля.

## Как бот работает на сервере

- **Облачный сервер (VPS), а не App Platform.** В App Platform каждый деплой
  запускается в новом контейнере, и файлы прошлой версии не сохраняются
  ([документация Timeweb](https://timeweb.cloud/docs/apps/how-it-works)): база
  `data/bot.db` (записи, рейтинг MVP, расписание) терялась бы при каждом
  обновлении. На VPS диск постоянный.
- **Long polling вместо вебхука** (`UPDATES_MODE=polling`). Бот сам забирает
  сообщения у MAX, поэтому серверу не нужны ни домен, ни SSL-сертификат, ни
  nginx, ни туннель — только исходящий интернет. Входящие порты, кроме SSH,
  открывать не нужно.
- **systemd** держит бота запущенным: перезапускает при падении и поднимает
  после перезагрузки сервера. Раз в сутки (04:30) база копируется в
  `data/backups/`, хранятся последние 14 дней.

> MAX официально называет long polling режимом «для разработки и
> тестирования»: у него ограничена скорость, события хранятся 24 часа
> ([документация](https://dev.max.ru/docs-api/methods/GET/updates)). Для одного
> футбольного чата этого с запасом хватает. Если MAX когда-нибудь ограничит
> polling, бот умеет работать и через вебхук (`UPDATES_MODE=webhook`) — тогда
> понадобится свой домен и HTTPS (Caddy/nginx с Let's Encrypt).

## 1. Какой сервер заказать

В панели Timeweb Cloud: **Облачные серверы → Создать**.

| Параметр | Что выбрать |
|---|---|
| Операционная система | **Ubuntu 24.04 LTS** (подойдёт и 22.04) |
| Регион | **Москва** (или Санкт-Петербург) — ближе к серверам MAX |
| Конфигурация | минимальная: **1 vCPU, 1 ГБ RAM, 15 ГБ NVMe** — боту хватает с большим запасом (он занимает ~100 МБ памяти, база — сотни килобайт) |
| Сеть | **публичный IPv4** — нужен, чтобы зайти на сервер по SSH и чтобы бот ходил в интернет |
| Доступ | **SSH-ключ** (добавьте свой публичный ключ `~/.ssh/id_ed25519.pub`); пароль тоже можно, но ключ надёжнее |
| Приложения / маркетплейс | ничего не ставить — скрипт установит всё сам |
| Бэкапы Timeweb | по желанию (платно); у бота есть свои ежедневные копии базы |
| Защита от DDoS, доп. IP, приватная сеть | не нужны |

Файрвол (если включаете в панели): **входящий — только TCP 22 (SSH)**,
исходящий — разрешить всё.

## 2. Установка

Подключитесь к серверу (IP — в панели Timeweb):

```bash
ssh root@IP_СЕРВЕРА
```

Скачайте и запустите скрипт установки:

```bash
curl -fsSL https://raw.githubusercontent.com/DannyKGZ/maxFootballBot/main/deploy/setup-server.sh -o setup-server.sh
bash setup-server.sh
```

Скрипт:
1. ставит Node.js 22, git, sqlite3 и инструменты сборки;
2. добавляет 1 ГБ swap (страховка для `npm` на сервере с 1 ГБ памяти) и
   ставит часовой пояс Москвы;
3. создаёт системного пользователя `maxbot` и скачивает код в
   `/opt/max-football-bot`;
4. собирает проект (`npm ci && npm run build`);
5. создаёт `.env` из `.env.example` с `UPDATES_MODE=polling`;
6. ставит сервис systemd и ежедневный бэкап.

> Если сделаете репозиторий приватным, добавьте на сервере deploy-ключ
> (GitHub → Settings → Deploy keys) и запустите
> `REPO=git@github.com:DannyKGZ/maxFootballBot.git bash setup-server.sh`.

## 3. Перенос настроек и данных с ПК

**Сначала остановите бота на ПК** (Ctrl+C в окне `dev-tunnel.sh`) и больше не
запускайте его там. Два бота с одним токеном будут мешать друг другу: оба
опубликуют запись по расписанию, а бот на ПК при старте снова включит вебхук и
перехватит сообщения у сервера.

**Настройки.** Откройте `.env` на сервере:

```bash
nano /opt/max-football-bot/.env
```

Перенесите значения из `.env` на ПК: `BOT_TOKEN`, `CHAT_ID`, `MAX_PLAYERS`,
`GAME_DAY_OF_WEEK`, `GAME_TIME`, `REMINDER_HOURS_BEFORE`, `PAYMENT_AMOUNT`,
`PAYMENT_DETAILS` и остальные. Для сервера обязательно:

```
UPDATES_MODE=polling
AUTO_REGISTER_WEBHOOK=false
PUBLIC_WEBHOOK_URL=
TIMEZONE=Europe/Moscow
```

**Данные** (записи, рейтинг MVP, расписание, шаблон `/описание`) — с ПК,
из папки проекта:

```bash
scp data/bot.db root@IP_СЕРВЕРА:/opt/max-football-bot/data/bot.db
```

и на сервере отдайте файл пользователю бота:

```bash
chown maxbot:maxbot /opt/max-football-bot/data/bot.db
```

Если данные переносить не нужно — пропустите: бот создаст пустую базу сам.

## 4. Запуск и проверка

```bash
systemctl start max-football-bot
journalctl -u max-football-bot -f
```

В логе должно быть:

```
[store] восстановлено из ./data/bot.db: записей …
[poller] снята подписка на вебхук (мешает long polling): https://…trycloudflare.com/webhook
[poller] приём сообщений через long polling (marker=нет)
[scheduler] запущен: "…" (Europe/Moscow), чат -69194922475584
```

Проверьте в чате: `/статус` — бот должен ответить. Выход из просмотра логов —
Ctrl+C (бот продолжит работать).

## 5. Повседневное управление

| Что | Команда на сервере |
|---|---|
| Статус | `systemctl status max-football-bot` |
| Логи в реальном времени | `journalctl -u max-football-bot -f` |
| Логи за сегодня | `journalctl -u max-football-bot --since today` |
| Перезапуск (например, после правки `.env`) | `systemctl restart max-football-bot` |
| Остановить / запустить | `systemctl stop max-football-bot` / `systemctl start max-football-bot` |

## 6. Обновление бота

На ПК: внесите изменения и отправьте их на GitHub (`git push`). На сервере:

```bash
bash /opt/max-football-bot/deploy/update.sh
```

Скрипт делает бэкап базы, скачивает новую версию (`git pull`), собирает её и
перезапускает бота. База и `.env` при обновлении не трогаются.

## 7. Бэкапы и восстановление

- Автоматически: каждый день в 04:30 → `/opt/max-football-bot/data/backups/bot-ДАТА.db`,
  хранятся 14 дней. Вручную: `sudo -u maxbot /opt/max-football-bot/deploy/backup.sh`.
- Скачать копию на ПК:
  `scp root@IP_СЕРВЕРА:/opt/max-football-bot/data/backups/bot-*.db .`
- Восстановить:
  ```bash
  systemctl stop max-football-bot
  cp /opt/max-football-bot/data/backups/bot-ДАТА.db /opt/max-football-bot/data/bot.db
  chown maxbot:maxbot /opt/max-football-bot/data/bot.db
  rm -f /opt/max-football-bot/data/bot.db-wal /opt/max-football-bot/data/bot.db-shm
  systemctl start max-football-bot
  ```

## 8. Если что-то не работает

| Симптом | Что проверить |
|---|---|
| Бот молчит | `journalctl -u max-football-bot -n 50`. Нет строки `приём сообщений через long polling` — бот не запустился (ошибка выше в логе). Есть `ошибка получения событий` — нет связи с MAX или неверный `BOT_TOKEN`. |
| `unable to get local issuer certificate` | не подхватился сертификат Минцифры — сервис запускайте только через systemd (в нём задан `NODE_EXTRA_CA_CERTS`), не через `node dist/index.js` вручную. |
| `Не задана обязательная переменная окружения: BOT_TOKEN` | не заполнен `.env` в `/opt/max-football-bot`. |
| Бот отвечает дважды / две записи по расписанию | бот ещё работает на ПК — остановите его там. |
| Запись публикуется не в тот чат | `CHAT_ID` в `.env`; узнать ID чата: напишите в него что-нибудь — в логе появится `сообщение из чата chat_id=…`. |
| После правки `.env` ничего не поменялось | `systemctl restart max-football-bot`. |
