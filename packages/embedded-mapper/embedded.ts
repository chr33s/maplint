import path from 'node:path';
import { indexText } from '../../src/spans.js';
import type { Mapping, MapperOutput, PositionEncoding } from '../../src/types.js';

interface EmbeddedSection {
  start: number;
  end: number;
  lang: string;
}

/** Small demonstration extractor. Not a conforming Vue/Svelte/Astro parser. */
export function extractEmbeddedSections(filename: string, original: string): EmbeddedSection[] {
  const ext = path.extname(filename).toLowerCase();
  const parts: EmbeddedSection[] = [];
  let pos = 0;
  if (ext === '.astro') {
    // Astro frontmatter must be the first non-whitespace line.
    const front = /^(?:﻿)?[ \t]*---[ \t]*(?:\r?\n)/.exec(original);
    if (front) {
      const endRe = /^[ \t]*---[ \t]*(?:\r?\n|$)/gm;
      endRe.lastIndex = front[0].length;
      const end = endRe.exec(original);
      if (end) {
        parts.push({ start: front[0].length, end: end.index, lang: 'ts' });
        pos = end.index + end[0].length;
      }
    }
  }
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
    const lang = attribute(attrs, 'lang') ?? 'js';
    const mime = attribute(attrs, 'type') ?? '';
    const hasSrc = /(?:^|\s)src\s*(?:=|\s|$)/i.test(attrs);
    if (hasSrc || !['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(lang) || (mime && !/^(?:module|(?:text|application)\/(?:javascript|typescript))$/.test(mime))) continue;
    parts.push({ start: tagEnd + 1, end: closing.index, lang });
  }
  return parts;
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
}

/** Produce the same virtual text for the SDK-free mapper process and the rule runner. */
export function buildEmbeddedVirtual(filename: string, original: string, encoding: PositionEncoding = 'utf-16'): MapperOutput {
  const sections = extractEmbeddedSections(filename, original);
  const offsets = indexText(original, encoding);
  const chunks: string[] = [];
  const mappings: Mapping[] = [];
  let virtualJsPos = 0;
  for (const { start, end } of sections) {
    if (chunks.length) {
      chunks.push('\n;\n');
      virtualJsPos += 3; // ASCII: same length in either encoding
    }
    const length = offsets.toEncoded(end) - offsets.toEncoded(start);
    chunks.push(original.slice(start, end));
    mappings.push([virtualJsPos, length, offsets.toEncoded(start), length, 0]);
    virtualJsPos += length;
  }
  const isJsx = sections.some((p) => p.lang.includes('x'));
  return { text: chunks.join(''), extension: isJsx ? '.tsx' : '.ts', mappings };
}
