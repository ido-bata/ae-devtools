/**
 * sourcemap.mjs — minimal Source Map v3 consumer (Issue #52).
 *
 * Implements just enough of the spec to answer "generated position ->
 * original position": base64 VLQ decode of `mappings`, `sources`,
 * `names`, and `sourcesContent` passthrough. No dependencies.
 *
 * Used to map an ExtendScript host error `{line, file}` back to the
 * TypeScript source position before it reaches diagnostics (#37 CAP064).
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64VAL = new Map([...B64].map((c, i) => [c, i]));

function decodeVlqSegment(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64VAL.get(ch);
    if (digit === undefined) throw new Error(`invalid base64 char '${ch}'`);
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) { shift += 5; continue; }
    const neg = value & 1;
    value >>= 1;
    values.push(neg ? -value : value);
    value = 0;
    shift = 0;
  }
  return values;
}

/** Parse mappings into per-generated-line segment lists.
 *  Each segment: [genCol, srcIdx, srcLine, srcCol, nameIdx?] (relative
 *  fields already accumulated). */
export function parseMappings(map) {
  const lines = [];
  let srcIdx = 0, srcLine = 0, srcCol = 0, nameIdx = 0;
  for (const lineStr of map.mappings.split(";")) {
    const segs = [];
    let genCol = 0;
    if (lineStr) {
      for (const seg of lineStr.split(",")) {
        const v = decodeVlqSegment(seg);
        genCol += v[0];
        if (v.length >= 4) {
          srcIdx += v[1]; srcLine += v[2]; srcCol += v[3];
          let name;
          if (v.length >= 5) { nameIdx += v[4]; name = map.names[nameIdx]; }
          segs.push({ genCol, src: srcIdx, line: srcLine, col: srcCol, name });
        } else {
          segs.push({ genCol }); // unmapped segment
        }
      }
    }
    lines.push(segs);
  }
  return lines;
}

/**
 * Look up the original position for a generated (1-based line,
 * 0-based column — the ExtendScript/tsc convention). Returns
 * { source, line, column, name } with 1-based line, or null when the
 * position is unmapped.
 */
export function lookup(map, genLine, genCol = 0) {
  const lines = map.__parsed ?? (map.__parsed = parseMappings(map));
  const segs = lines[genLine - 1];
  if (!segs || !segs.length) return null;
  // greatest segment with genCol <= requested column
  let best = null;
  for (const s of segs) {
    if (s.genCol <= genCol && s.src !== undefined) best = s;
    if (s.genCol > genCol) break;
  }
  if (!best) return null;
  return {
    source: map.sources[best.src] ?? map.sources[0],
    line: best.line + 1,
    column: best.col,
    name: best.name ?? null,
    content: map.sourcesContent?.[best.src] ?? null,
  };
}
