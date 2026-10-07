import { startSticky } from "./stickyLogic";
import fs from "fs";
import http from "http";
import https from "https";
import { config } from "./config";
import { createWebhookApp } from "./webhookServer";
import { startScheduler } from "./scheduler";
import { startPolling, stopPolling } from "./poller";
import { refreshRosterOnStartup } from "./sessionLogic";
import { refreshVoteMessage } from "./voteLogic";
import { loadSessionsFromDisk, flushSessionsToDiskSync } from "./store";
import { deleteSubscription, getSubscriptions, registerWebhook, setBotCommands } from "./maxApi";
import { USER_MENU_COMMANDS } from "./actions";

async function main(): Promise<void> {
  loadSessionsFromDisk();

  const app = createWebhookApp();

  // Если заданы TLS_CERT_PATH/TLS_KEY_PATH — поднимаем HTTPS напрямую.
  // Иначе — обычный HTTP-сервер (для случая, когда TLS терминируется на
  // reverse-proxy вроде nginx/Caddy/Traefik перед этим процессом).
  //
  // Начиная с 25 мая 2026 MAX принимает вебхуки только по HTTPS (порт 443) с
  // сертификатом от доверенного центра или Минцифры — самоподписанные
  // сертификаты и голый HTTP на стороне MAX больше не поддерживаются.
  let server: http.Server | https.Server;
  if (config.tlsCertPath && config.tlsKeyPath) {
    server = https.createServer(
      {
        cert: fs.readFileSync(config.tlsCertPath),
        key: fs.readFileSync(config.tlsKeyPath),
      },
      app,
    );
    console.log("[server] запущен в режиме HTTPS");
  } else {
    server = http.createServer(app);
    console.log(
      "[server] запущен в режиме HTTP — предполагается TLS-терминация на reverse-proxy",
    );
  }

  // В режиме polling снаружи к боту никто не ходит — слушаем только localhost (для /health).
  const host = config.updatesMode === "polling" ? "127.0.0.1" : undefined;
  server.listen(config.port, host, () => {
    console.log(`[server] слушаю ${host ?? "все адреса"}:${config.port}, путь вебхука: /webhook`);
  });

  if (config.updatesMode === "polling") {
    void startPolling();
  } else if (config.autoRegisterWebhook) {
    if (!config.publicWebhookUrl) {
      console.warn("[webhook] AUTO_REGISTER_WEBHOOK=true, но PUBLIC_WEBHOOK_URL не задан");
    } else {
      try {
        const res = await registerWebhook(
          config.publicWebhookUrl,
          ["message_created", "message_callback", "bot_started"],
          config.webhookSecret || undefined,
        );
        console.log("[webhook] регистрация подписки:", res);

        // У quick tunnel новый адрес при каждом запуске — старые подписки указывают
        // в пустоту и могут мешать доставке. Оставляем только текущий адрес.
        const { subscriptions } = await getSubscriptions();
        for (const sub of subscriptions) {
          if (sub.url === config.publicWebhookUrl) continue;
          await deleteSubscription(sub.url);
          console.log(`[webhook] удалена старая подписка: ${sub.url}`);
        }
      } catch (err) {
        console.error("[webhook] не удалось зарегистрировать вебхук:", err);
      }
    }
  }

  // Меню «/» в MAX общее для всех — показываем в нём только команды участников.
  setBotCommands(USER_MENU_COMMANDS)
    .then(() => console.log("[bot] меню команд обновлено: /status, /mvp, /help"))
    .catch((err) => console.warn("[bot] не удалось обновить меню команд:", err instanceof Error ? err.message : err));

  startScheduler();
  startSticky();
  console.log(`[bot] чаты: ${config.chatIds.join(", ") || "не заданы (CHAT_IDS)"}`);
  for (const chatId of config.chatIds) {
    void refreshRosterOnStartup(chatId);
    void refreshVoteMessage(chatId); // текст и кнопки голосования — по текущей версии бота
  }

  const shutdown = (signal: string) => {
    console.log(`[server] получен ${signal}, сохраняю состояние и завершаюсь`);
    stopPolling();
    flushSessionsToDiskSync();
    server.close(() => process.exit(0));
    // На случай, если сервер не закрылся за разумное время
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
