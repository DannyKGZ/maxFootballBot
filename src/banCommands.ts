// Команды — только текстовые сообщения, без реального бана.

const OWNER_ID = 114829841;
const command = (name: string) => new RegExp(`^\\/?${name}(?:@[A-Za-z0-9_]+)?$`, "i");

export const BAN_VARTAN_RE = command("БанВартан");
export const BAN_ILYAN_RE = command("БанИльян");
export const BAN_ALEKSANDR_RE = command("БанАлексан");
export const BAN_OLEG_RE = command("БанОлег");

export async function banVartanCommand(userId: number): Promise<string | null> {
  if (userId !== OWNER_ID) return null;
  return 'Пользователь Var забанен на 15 минут';
}

export async function banIlyanCommand(userId: number): Promise<string | null> {
  if (userId !== OWNER_ID) return null;
  return 'Илья забанен на 15 минут. Hala Madrid';
}

export async function banAleksandrCommand(userId: number): Promise<string | null> {
  if (userId !== OWNER_ID) return null;
  return 'БанАлексан пользователь Александр забанен на 15 минут.';
}

export async function banOlegCommand(userId: number): Promise<string | null> {
  if (userId !== OWNER_ID) return null;
  return 'Олега не удалось забанить. Родственники против';
}
