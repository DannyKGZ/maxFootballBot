/**
 * Разбивка длинных сообщений на части: лимит текста в MAX — 4000 символов,
 * сообщение длиннее API не принимает (HTTP 400), и отправка целиком падает.
 *
 * Разбиваем «по логике»: единица — логический блок (раздел инструкции:
 * заголовок и строки под ним). Блоки набираются в сообщение целиком, пока
 * влезают, так что раздел не разрывается посередине. Если один блок сам
 * длиннее лимита, он делится по строкам, а слишком длинная строка — по символам.
 */

/** Лимит MAX — 4000 символов, оставляем запас на нумерацию частей. */
export const MAX_MESSAGE_CHARS = 3800;

/** Логический блок: заголовок раздела и строки под ним. */
export type Block = string[];

/** Блок целиком, одной строкой — как он выглядит в сообщении. */
function blockText(block: Block): string {
  return block.join("\n");
}

/** Строка длиннее лимита (теоретически) — режем по символам, иначе MAX откажет. */
function splitLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
  return out;
}

/** Блок длиннее лимита — делим по строкам (заголовок останется в первой части). */
function splitOversizedBlock(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (const piece of splitLine(line, limit)) {
      if (current && current.length + 1 + piece.length > limit) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Набирает блоки в сообщения не длиннее `limit`. Возвращает хотя бы одну часть;
 * если частей больше одной, в конце каждой — «— часть N из M», чтобы человек
 * видел, что инструкция продолжается.
 */
export function packBlocks(blocks: Block[], limit: number = MAX_MESSAGE_CHARS): string[] {
  const texts = blocks.map(blockText).filter((t) => t.trim().length > 0);
  const parts: string[] = [];
  let current = "";
  for (const text of texts) {
    for (const piece of splitOversizedBlock(text, limit)) {
      if (current && current.length + 2 + piece.length > limit) {
        parts.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
  }
  if (current) parts.push(current);
  if (parts.length === 0) return [""];
  if (parts.length === 1) return parts;
  return parts.map((p, i) => `${p}\n\n— часть ${i + 1} из ${parts.length}`);
}
