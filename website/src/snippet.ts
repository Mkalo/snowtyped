const cut = /^\/\/ ---cut---\r?\n/m;

export function visibleSnippet(source: string): string {
  const match = cut.exec(source);
  const visible = match ? source.slice(match.index + match[0].length) : source;
  return visible.trim();
}
