/** RFC 6901 JSON Pointer helpers. */

export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append tokens to a pointer. `join('', 'properties', 'a')` is `/properties/a`. */
export function join(base: string, ...tokens: Array<string | number>): string {
  let out = base;
  for (const token of tokens) out += '/' + escapeToken(String(token));
  return out;
}

/** Resolve a pointer against a document. Returns `undefined` when unresolvable. */
export function resolve(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = unescapeToken(raw);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, token)) return undefined;
      current = record[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}
