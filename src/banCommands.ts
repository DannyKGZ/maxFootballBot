const OWNER_ID = 59201381;
const CHAT_ID = -69194922475584;
const command = (name: string) => new RegExp(`^\\/?${name}(?:@[A-Za-z0-9_]+)?$`, "i");

export const BAN_VARTAN_RE = command("БанВартан");
export const BAN_ILYAN_RE = command("БанИльян");
export const BAN_ALEKSANDR_RE = command("БанАлексан");
export const BAN_OLEG_RE = command("БанОлег");

const allowed = (userId: number, chatId: number) => userId === OWNER_ID && chatId === CHAT_ID;

export async function banVartanCommand(userId: number, chatId: number): Promise<string | null> {
  if (!allowed(userId, chatId)) return null;
  return "Пользователь Var забанен на 15 минут";
}

export async function banIlyanCommand(userId: number, chatId: number): Promise<string | null> {
  if (!allowed(userId, chatId)) return null;
  return "Илья забанен на 15 минут. Hala Madrid";
}

export async function banAleksandrCommand(userId: number, chatId: number): Promise<string | null> {
  if (!allowed(userId, chatId)) return null;
  return "БанАлексан пользователь Александр забанен на 15 минут.";
}

export async function banOlegCommand(userId: number, chatId: number): Promise<string | null> {
  if (!allowed(userId, chatId)) return null;
  return "Олега не удалось забанить. Родственники против";
}
