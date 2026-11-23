import { db } from "./db";

export function isGameCancelled(chatId: number, gameDate: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM game_cancellations WHERE chat_id = ? AND game_date = ?").get(chatId, gameDate));
}
