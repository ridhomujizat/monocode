/**
 * HN comment handling, kept pure: the Algolia `items` response nests comments
 * as a tree and stores bodies as HTML, neither of which we render raw.
 */

export type Comment = { author: string; text: string; depth: number };

type RawComment = { author?: unknown; text?: unknown; children?: unknown };

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** HTML to plain text: block tags become newlines, entities are decoded. */
export function stripHtml(html: string): string {
  const withBreaks = html.replace(/<[^>]*>/g, (tag) =>
    /^<\/?(p|br|pre|li|blockquote)\b/i.test(tag) ? "\n" : "",
  );
  return withBreaks
    .replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, (entity) => {
      const lower = entity.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      const numeric = /^&#x([0-9a-f]+);$/.exec(lower);
      if (numeric) return String.fromCodePoint(parseInt(numeric[1], 16));
      return entity;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Depth-first flatten of the comment tree. Depth is capped so deep threads
 * stay readable, `max` bounds the render, and bodies without an author are
 * dropped (deleted comments).
 */
const MAX_DEPTH = 3;

export function flattenComments(root: unknown, max: number): Comment[] {
  const out: Comment[] = [];
  const walk = (node: unknown, depth: number) => {
    if (
      out.length >= max ||
      depth > MAX_DEPTH ||
      !node ||
      typeof node !== "object"
    ) {
      return;
    }
    const entry = node as RawComment;
    if (typeof entry.author === "string" && typeof entry.text === "string") {
      const text = stripHtml(entry.text);
      if (text) out.push({ author: entry.author, text, depth });
    }
    if (!Array.isArray(entry.children)) return;
    for (const child of entry.children) {
      if (out.length >= max) return;
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
