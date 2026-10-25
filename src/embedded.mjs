import path from 'node:path';

/** Small demonstration extractor. Not a conforming Vue/Svelte/Astro parser. */
export function extractEmbeddedSections(filename, original) {
  const ext = path.extname(filename).toLowerCase();
  const parts = [];
  if (ext === '.astro') {
    // Astro frontmatter must be the first non-whitespace line.
    const front = /^(?:\uFEFF)?[ \t]*---[ \t]*(?:\r?\n)/.exec(original);
    if (front) {
      const endRe = /^[ \t]*---[ \t]*(?:\r?\n|$)/gm;
      endRe.lastIndex = front[0].length;
      const end = endRe.exec(original);
      if (end) parts.push({ start: front[0].length, end: end.index, lang: 'ts' });
    }
  }
  let pos = 0;
  while (pos < original.length) {
    const open = original.indexOf('<', pos);
    if (open < 0) break;
    if (original.startsWith('<!--', open)) {
      const end = original.indexOf('-->', open + 4);
      pos = end < 0 ? original.length : end + 3;
      continue;
    }
    if (!/^<script(?=[\s/>])/i.test(original.slice(open, open + 9))) {
      pos = open + 1;
      continue;
    }
    // Parse the opening tag, respecting quoted attributes and brace expressions.
    let quote = null;
    let braces = 0;
    let tagEnd = -1;
    for (let i = open + 7; i < original.length; i++) {
      const ch = original[i];
      if (quote) { if (ch === quote && original[i - 1] !== '\\') quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{') braces++;
      if (ch === '}') braces = Math.max(0, braces - 1);
      if (ch === '>' && braces === 0) { tagEnd = i; break; }
    }
    if (tagEnd < 0) break;
    const attrs = original.slice(open + 7, tagEnd);
    const close = /<\/script\s*>/gi;
    close.lastIndex = tagEnd + 1;
    const closing = close.exec(original);
    if (!closing) break;
    pos = closing.index + closing[0].length;
    const langMatch = /(?:^|\s)lang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const lang = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? 'js').toLowerCase();
    const typeMatch = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const mime = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').toLowerCase();
    const hasSrc = /(?:^|\s)src\s*(?:=|\s|$)/i.test(attrs);
    if (hasSrc || !['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(lang) || (mime && !/^(?:module|(?:text|application)\/(?:javascript|typescript))$/.test(mime))) continue;
    parts.push({ start: tagEnd + 1, end: closing.index, lang });
  }
  return parts.sort((a, b) => a.start - b.start).filter((p, i, xs) => i === 0 || p.start >= xs[i - 1].end);
}

/** Produce the same virtual text for the SDK-free mapper process and the rule runner. */
export function buildEmbeddedVirtual(filename, original, encoding = 'utf-16') {
  const sections = extractEmbeddedSections(filename, original);
  const chunks = [];
  const mappings = [];
  let virtualJsPos = 0;
  function encodedPos(s, index) {
    return encoding === 'utf-8' ? Buffer.byteLength(s.slice(0, index), 'utf8') : index;
  }
  function encodedLength(s) { return encoding === 'utf-8' ? Buffer.byteLength(s, 'utf8') : s.length; }
  for (const { start, end } of sections) {
    if (chunks.length) {
      chunks.push('\n;\n');
      virtualJsPos += 3;
    }
    const text = original.slice(start, end);
    chunks.push(text);
    mappings.push([
      virtualJsPos, encodedLength(text), encodedPos(original, start),
      encodedPos(original, end) - encodedPos(original, start), 0,
    ]);
    virtualJsPos += encodedLength(text);
  }
  const isJsx = sections.some((p) => p.lang.includes('x'));
  return { text: chunks.join(''), extension: isJsx ? '.tsx' : '.ts', mappings };
}
