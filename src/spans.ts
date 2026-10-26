import type { LineColumn, Mapping, MapperOutput, PositionEncoding, SourceSpan } from './types.js';

// All linter offsets are JS string (UTF-16) indices. Protocol offsets may be UTF-8 bytes.

/** Offset and line lookups for one text, precomputed so each lookup is O(1) or a binary search. */
export interface TextIndex {
  readonly text: string;
  readonly encoding: PositionEncoding;
  /** Convert a JS string index into an offset in the negotiated encoding. */
  toEncoded(index: number): number;
  /** Convert an offset in the negotiated encoding into a JS string index; -1 if it is not a character boundary. */
  fromEncoded(offset: number): number;
  /** 1-based line and column of a JS string index. */
  lineColumn(index: number): LineColumn;
}

export function indexText(text: string, encoding: PositionEncoding): TextIndex {
  let lineStarts: number[] | undefined; // Virtual texts never need lines, so build them on first use.
  const lineColumn = (index: number): LineColumn => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    }
    const line = lastAtOrBelow(lineStarts, index);
    return { line: line + 1, column: index - lineStarts[line] + 1 };
  };
  // UTF-16, and UTF-8 for ASCII-only text, are the JS string indices themselves.
  if (encoding === 'utf-16' || !/[^\x00-\x7f]/.test(text)) {
    return { text, encoding, lineColumn, toEncoded: index => index,
      fromEncoded: offset => offset >= 0 && offset <= text.length ? offset : -1 };
  }
  // bytes[i] is the UTF-8 length of text.slice(0, i). As in Buffer.byteLength, a slice ending in a lone or split
  // surrogate counts it as U+FFFD (3 bytes); a pair's second half adds the 4th byte. The table is strictly increasing.
  const bytes = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[i + 1] = bytes[i] + (unit < 0x80 ? 1 : unit < 0x800 ? 2 : endsPair(text, i) ? 1 : 3);
  }
  return {
    text, encoding, lineColumn,
    toEncoded: index => bytes[index],
    fromEncoded(offset) {
      const index = lastAtOrBelow(bytes, offset);
      // An index between the halves of a surrogate pair is not a character boundary.
      return bytes[index] === offset && !endsPair(text, index) ? index : -1;
    },
  };
}

/** Whether `text[i]` is the low half of a surrogate pair. */
function endsPair(text: string, i: number): boolean {
  const unit = text.charCodeAt(i);
  const previous = text.charCodeAt(i - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
}

/** Index of the last element of the ascending `values` that is <= `target`, or 0. */
function lastAtOrBelow(values: ArrayLike<number>, target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (values[mid] <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Decode an encoded `[start, end)` of a text; null unless it is a valid range of the string. */
export function decodeSpan(text: TextIndex, start: number, end: number): SourceSpan | null {
  const span = { start: text.fromEncoded(start), end: text.fromEncoded(end) };
  return span.start >= 0 && span.start <= span.end ? span : null;
}

/** Map a virtual-text span to the original file, or null when no mapping covers it safely. */
export function mappingForSpan(
  mappings: Mapping[],
  virtual: TextIndex,
  original: TextIndex,
  start: number,
  end: number,
): SourceSpan | null {
  const spanStart = virtual.toEncoded(start);
  const spanEnd = virtual.toEncoded(end);
  for (const [vStart, vLength, oStart, oLength, kind] of mappings) {
    if (spanStart < vStart || spanEnd > vStart + vLength) continue;
    if (kind === 0 && vLength === oLength) { // 1:1 verbatim mapping
      return decodeSpan(original, oStart + spanStart - vStart, oStart + spanEnd - vStart);
    }
    // Atoms/aliases have no meaningful partial positions. Map only whole atoms.
    if ((kind === 1 || kind === 2) && spanStart === vStart && spanEnd === vStart + vLength) {
      return decodeSpan(original, oStart, oStart + oLength);
    }
  }
  // Synthetic text has no original location: never invent a diagnostic span.
  return null;
}

/** Virtual output for a plain JS/TS file: the file itself, mapped 1:1. */
export function identityOutput(text: string, extension: string): MapperOutput {
  return { text, extension, mappings: [[0, text.length, 0, text.length, 0]] };
}
