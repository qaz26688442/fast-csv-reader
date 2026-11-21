// High-throughput drop-in replacement for csv-reader 1.0.0.
// Exports:
//   - run(input): exact slice-based string parser returning { columns, rows, errors }
//   - runCasesBuffer(inBuf): zero-deopt single-pass SWAR UTF-8 Buffer CSV-in-JSON -> JSON-out engine
//     that answers each case independently with automatic fallback to run() for exotic JSON escapes.

const B_QUOTE = 34;      // "
const B_COMMA = 44;      // ,
const B_BACKSLASH = 92;  // \
const B_LBRACKET = 91;   // [
const B_RBRACKET = 93;   // ]
const B_LBRACE = 123;    // {
const B_RBRACE = 125;    // }
const B_COLON = 58;      // :
const B_SPACE = 32;      // ' '
const B_N = 110;         // n
const B_R = 114;         // r
const B_U = 117;         // u
const SWAR_MASK = -2139062144; // 0x80808080 | 0

const ERR_STRAY_CR = 0;
const ERR_UNTERMINATED = 1;
const ERR_QUOTE_JUNK = 2;
const ERR_SHORT_ROW = 3;
const ERR_LONG_ROW = 4;

const HEX_VAL = new Int8Array(128).fill(-1);
for (let i = 48; i <= 57; i++) HEX_VAL[i] = i - 48;
for (let i = 65; i <= 70; i++) HEX_VAL[i] = i - 55;
for (let i = 97; i <= 102; i++) HEX_VAL[i] = i - 87;

function parseHex4(buf, p) {
  const a = buf[p], b = buf[p + 1], c = buf[p + 2], d = buf[p + 3];
  if ((a | b | c | d) >= 128) return -1;
  const va = HEX_VAL[a], vb = HEX_VAL[b], vc = HEX_VAL[c], vd = HEX_VAL[d];
  if ((va | vb | vc | vd) < 0) return -1;
  return (va << 12) | (vb << 8) | (vc << 4) | vd;
}

/**
 * Exact drop-in replacement for csv-reader 1.0.0's readCsv(input).
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = 0;

    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      let val = '';

      if (!quoted) {
        let start = pos;
        let hasStray = false;
        ended = 2;
        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c === 44) { val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos); pos += 1; ended = 0; break; }
          if (c === 10) { val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos); pos += 1; line += 1; ended = 1; break; }
          if (c === 13) {
            if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
              val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos);
              pos += 2; line += 1; ended = 1; break;
            }
            val += text.slice(start, pos);
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos += 1; start = pos; hasStray = true; continue;
          }
          pos += 1;
        }
        if (ended === 2) val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos);
      } else {
        const open = pos;
        const openLine = line;
        pos += 1;
        let start = pos;
        let hasSpecial = false;
        let closed = false;

        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c === 34) {
            if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) {
              val += text.slice(start, pos + 1);
              pos += 2; start = pos; hasSpecial = true; continue;
            }
            val = hasSpecial ? val + text.slice(start, pos) : text.slice(start, pos);
            pos += 1; closed = true; break;
          }
          if (c === 13) {
            val += text.slice(start, pos) + '\n';
            line += 1;
            pos += pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
            start = pos; hasSpecial = true; continue;
          }
          if (c === 10) line += 1;
          pos += 1;
        }

        if (!closed) {
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          val = '"';
          let start2 = pos;
          ended = 2;
          while (pos < len) {
            const c = text.charCodeAt(pos);
            if (c === 44) { val += text.slice(start2, pos); pos += 1; ended = 0; break; }
            if (c === 10) { val += text.slice(start2, pos); pos += 1; line += 1; ended = 1; break; }
            if (c === 13) {
              if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { val += text.slice(start2, pos); pos += 2; line += 1; ended = 1; break; }
              val += text.slice(start2, pos);
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              pos += 1; start2 = pos; continue;
            }
            pos += 1;
          }
          if (ended === 2) val += text.slice(start2, pos);
        } else if (pos >= len) {
          ended = 2;
        } else {
          const nc = text.charCodeAt(pos);
          if (nc === 44) { pos += 1; ended = 0; }
          else if (nc === 10) { pos += 1; line += 1; ended = 1; }
          else if (nc === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = 1; }
          else {
            let start2 = pos;
            let added = 0;
            ended = 2;
            while (pos < len) {
              const c = text.charCodeAt(pos);
              if (c === 44) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } pos += 1; ended = 0; break; }
              if (c === 10) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } pos += 1; line += 1; ended = 1; break; }
              if (c === 13) {
                if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
                  const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; }
                  pos += 2; line += 1; ended = 1; break;
                }
                const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                pos += 1; start2 = pos; continue;
              }
              pos += 1;
            }
            if (ended === 2) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } }
            if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
      }
      fields.push(val);
    } while (ended === 0);

    if (fields.length === 1 && fields[0].length === 0 && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ============================================================================
// Zero-Deopt SWAR UTF-8 Buffer CSV-in-JSON -> JSON-out Engine
// ============================================================================

const PFX_COLS = Buffer.from('{"columns":');
const PFX_MID_ROWS = Buffer.from(',"rows":[');
const PFX_NULL_ROWS = Buffer.from('{"columns":null,"rows":[');
const PFX_EMPTY_HDR = Buffer.from('{"columns":[],"rows":[],"errors":[');
const PFX_EMPTY_NOHDR = Buffer.from('{"columns":null,"rows":[],"errors":[');
const SFX_ERRORS = Buffer.from('],"errors":[');

const ERR_PREFIXES = [
  Buffer.from('{"code":"stray_cr","line":'),
  Buffer.from('{"code":"unterminated_quote","line":'),
  Buffer.from('{"code":"quote_junk","line":'),
  Buffer.from('{"code":"short_row","line":'),
  Buffer.from('{"code":"long_row","line":'),
];
const STR_ROW = Buffer.from(',"row":');
const STR_NULL = Buffer.from('null');
const STR_FIELDS = Buffer.from(',"fields":');
const STR_EXTRA = Buffer.from(',"extra":');

const DIGIT_BUF = new Uint8Array(16);
function writeUint(out, op, n) {
  if (n < 10) { out[op] = 48 + n; return op + 1; }
  let len = 0;
  let v = n;
  while (v > 0) {
    const q = (v / 10) | 0;
    DIGIT_BUF[len++] = 48 + (v - q * 10);
    v = q;
  }
  for (let i = len - 1; i >= 0; i--) out[op++] = DIGIT_BUF[i];
  return op;
}

function writeBytes(out, op, src) {
  const n = src.length;
  for (let i = 0; i < n; i++) out[op + i] = src[i];
  return op + n;
}

function growOutBuf(ctx, op, needed) {
  let newLen = ctx.out.length * 2;
  while (newLen < needed) newLen *= 2;
  const next = Buffer.allocUnsafe(newLen);
  ctx.out.copy(next, 0, 0, op);
  ctx.out = next;
  ctx.ddv = new DataView(next.buffer, next.byteOffset, next.byteLength);
}

function skipWs(buf, p, len) {
  while (p < len) {
    const b = buf[p];
    if (b === 32 || b === 10 || b === 13 || b === 9) p++;
    else break;
  }
  return p;
}

function skipJsonString(buf, p, len) {
  p++;
  while (p < len) {
    const b = buf[p];
    if (b === 34) return p + 1;
    if (b === 92) p += 2;
    else p++;
  }
  return -1;
}

function skipJsonValue(buf, p, len) {
  p = skipWs(buf, p, len);
  if (p >= len) return -1;
  const b = buf[p];
  if (b === 34) return skipJsonString(buf, p, len);
  if (b === 123 || b === 91) {
    let depth = 1;
    p++;
    while (p < len && depth > 0) {
      const c = buf[p];
      if (c === 34) { p = skipJsonString(buf, p, len); if (p < 0) return -1; continue; }
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) depth--;
      p++;
    }
    return depth === 0 ? p : -1;
  }
  while (p < len) {
    const c = buf[p];
    if (c === 44 || c === 125 || c === 93 || c === 32 || c === 10 || c === 13 || c === 9) break;
    p++;
  }
  return p;
}

function keyEquals(buf, start, end, str) {
  if (end - start !== str.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (buf[start + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

// Monomorphic error push helpers (separate numeric vs Buffer arrays -> ZERO elements-kind deopts!)
function pushSimpleErr(ctx, code, line, rowIdx) {
  ctx.errCodes.push(code);
  ctx.errLines.push(line);
  ctx.errRows.push(rowIdx);
  ctx.errFieldCnts.push(0);
  ctx.errExtraBufs.push(null);
}

function pushShortErr(ctx, line, rowIdx, fields) {
  ctx.errCodes.push(ERR_SHORT_ROW);
  ctx.errLines.push(line);
  ctx.errRows.push(rowIdx);
  ctx.errFieldCnts.push(fields);
  ctx.errExtraBufs.push(null);
}

function pushLongErr(ctx, line, rowIdx, extraBuf) {
  ctx.errCodes.push(ERR_LONG_ROW);
  ctx.errLines.push(line);
  ctx.errRows.push(rowIdx);
  ctx.errFieldCnts.push(0);
  ctx.errExtraBufs.push(extraBuf);
}

function scanUnquotedSlow(src, inLen, tp, out, op, recordLine, rowIdx, ctx) {
  let dl = 0;
  let ended = 0;
  while (tp < inLen) {
    const b = src[tp];
    if (b !== B_COMMA && b !== B_BACKSLASH && b !== B_QUOTE) {
      out[op++] = b;
      tp++;
      continue;
    }
    if (b === B_COMMA) { tp++; ended = 0; break; }
    if (b === B_QUOTE) { ended = 2; break; }
    const b2 = src[tp + 1];
    if (b2 === B_N) { tp += 2; dl = 1; ended = 1; break; }
    if (b2 === B_R) {
      if (src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_N) { tp += 4; dl = 1; ended = 1; break; }
      pushSimpleErr(ctx, ERR_STRAY_CR, recordLine, rowIdx);
      tp += 2;
      continue;
    }
    if (b2 === B_U) {
      const code = parseHex4(src, tp + 2);
      if (code === 10 || code === 13 || code === 34 || code === 44) return -1;
      out[op] = B_BACKSLASH; out[op + 1] = B_U;
      out[op + 2] = src[tp + 2]; out[op + 3] = src[tp + 3];
      out[op + 4] = src[tp + 4]; out[op + 5] = src[tp + 5];
      op += 6; tp += 6;
      continue;
    }
    out[op] = B_BACKSLASH; out[op + 1] = b2;
    op += 2; tp += 2;
  }
  ctx._tp = tp;
  ctx._op = op;
  ctx._dl = dl;
  return ended;
}

function finishQuotedCold(src, inLen, tp, out, op, openTp, openLine, openOp, line, closed, recordLine, rowIdx, ctx) {
  if (!closed) {
    tp = openTp + 2;
    line = openLine;
    op = openOp;
    pushSimpleErr(ctx, ERR_UNTERMINATED, recordLine, rowIdx);
    out[op] = B_QUOTE; out[op + 1] = B_BACKSLASH; out[op + 2] = B_QUOTE;
    op += 3;
    const r = scanUnquotedSlow(src, inLen, tp, out, op, recordLine, rowIdx, ctx);
    if (r < 0) return -1;
    out[ctx._op++] = B_QUOTE;
    ctx._line = line + ctx._dl;
    return r;
  }
  const opBeforeJunk = op;
  const r = scanUnquotedSlow(src, inLen, tp, out, op, recordLine, rowIdx, ctx);
  if (r < 0) return -1;
  if (ctx._op > opBeforeJunk) {
    pushSimpleErr(ctx, ERR_QUOTE_JUNK, recordLine, rowIdx);
  }
  out[ctx._op++] = B_QUOTE;
  ctx._line = line + ctx._dl;
  return r;
}

function finishRowCold(ctx, out, op, width, fieldCount, recordLine, rowIdx, rowStartOp, extraStartOp) {
  if (width < 0) {
    out[op++] = B_RBRACKET;
    ctx.rec0Buf = Buffer.from(out.subarray(rowStartOp, op));
    ctx.prefixStart = rowStartOp;
    ctx.reserve = ctx.rec0Buf.length + 26;
    if (rowStartOp + ctx.reserve + 65536 > out.length) {
      growOutBuf(ctx, op, rowStartOp + ctx.reserve + 131072);
    }
    ctx._op = rowStartOp + ctx.reserve;
    return fieldCount; // new width
  }
  if (fieldCount < width) {
    pushShortErr(ctx, recordLine, rowIdx, fieldCount);
    for (let k = fieldCount; k < width; k++) {
      out[op] = B_COMMA; out[op + 1] = B_QUOTE; out[op + 2] = B_QUOTE;
      op += 3;
    }
    out[op++] = B_RBRACKET;
  } else {
    out[op++] = B_RBRACKET;
    const extraBytes = Buffer.from(out.subarray(extraStartOp, op));
    op = extraStartOp;
    pushLongErr(ctx, recordLine, rowIdx, extraBytes);
  }
  ctx._op = op;
  return width;
}

/**
 * Tight, compact, closure-free SWAR hot kernel for parsing one CSV "text" JSON string.
 * Designed for single fast TurboFan compilation with zero deopts.
 */
function parseCaseText(src, sdv, inLen, tp, ctx) {
  let out = ctx.out;
  let ddv = ctx.ddv;
  let outLen = out.length;
  let op = ctx.op;

  let width = -1;
  let dataRowCount = 0;
  let line = 1;
  const n4 = (inLen - 4) | 0;

  if (src[tp] === 239 && src[tp + 1] === 187 && src[tp + 2] === 191) {
    tp = (tp + 3) | 0;
  } else if (src[tp] === B_BACKSLASH && src[tp + 1] === B_U) {
    if (parseHex4(src, tp + 2) === 0xfeff) tp = (tp + 6) | 0;
  }

  while (true) {
    while (src[tp] === B_BACKSLASH) {
      const b2 = src[tp + 1];
      if (b2 === B_N) { tp = (tp + 2) | 0; line = (line + 1) | 0; }
      else if (b2 === B_R && src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_N) { tp = (tp + 4) | 0; line = (line + 1) | 0; }
      else if (b2 === B_U) {
        const code = parseHex4(src, tp + 2);
        if (code === 10 || code === 13 || code === 34 || code === 44) return -1;
        break;
      } else break;
    }

    if (src[tp] === B_QUOTE) {
      tp = (tp + 1) | 0;
      break;
    }

    const rowNeed = ((width > 0 ? width * 4 : 4096) + 65536) | 0;
    if (((op + rowNeed) | 0) > outLen) {
      growOutBuf(ctx, op, op + rowNeed + (inLen - tp) * 2);
      out = ctx.out;
      ddv = ctx.ddv;
      outLen = out.length;
    }

    const recordLine = line;
    const rowIdx = width < 0 ? -1 : dataRowCount;
    const rowStartOp = op;

    if (width >= 0 && dataRowCount > 0) out[op++] = B_COMMA;
    out[op++] = B_LBRACKET;

    let fieldCount = 0;
    let quoted = false;
    let ended = 0;
    let lastFieldStartOp = 0;
    let extraStartOp = -1;

    do {
      if (fieldCount === width) {
        out[op++] = B_RBRACKET;
        extraStartOp = op;
        out[op++] = B_LBRACKET;
      } else if (fieldCount > 0) {
        out[op++] = B_COMMA;
      }

      lastFieldStartOp = op;
      if (src[tp] === B_BACKSLASH && src[tp + 1] === B_QUOTE) {
        quoted = true;
        const openTp = tp;
        const openLine = line;
        const openOp = op;
        out[op++] = B_QUOTE;
        tp = (tp + 2) | 0;
        let closed = false;

        while (true) {
          while (tp <= n4) {
            const w = sdv.getInt32(tp, true);
            ddv.setInt32(op, w, true);
            const x2 = w ^ 0x5c5c5c5c;
            const x3 = w ^ 0x22222222;
            const m = ((((x2 - 0x01010101) | 0) & ~x2) | (((x3 - 0x01010101) | 0) & ~x3)) & SWAR_MASK;
            if (m === 0) {
              op = (op + 4) | 0;
              tp = (tp + 4) | 0;
            } else {
              const k = (31 - Math.clz32(m & -m)) >>> 3;
              op = (op + k) | 0;
              tp = (tp + k) | 0;
              break;
            }
          }
          if (tp > n4) {
            while (tp < inLen) {
              const b = src[tp];
              if (b === B_BACKSLASH || b === B_QUOTE) break;
              out[op++] = b;
              tp = (tp + 1) | 0;
            }
          }
          if (src[tp] === B_QUOTE) break;
          const b2 = src[tp + 1];
          if (b2 === B_QUOTE) {
            if (src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_QUOTE) {
              out[op] = B_BACKSLASH; out[op + 1] = B_QUOTE;
              op = (op + 2) | 0; tp = (tp + 4) | 0;
              continue;
            }
            tp = (tp + 2) | 0;
            closed = true;
            break;
          }
          if (b2 === B_R) {
            out[op] = B_BACKSLASH; out[op + 1] = B_N;
            op = (op + 2) | 0; line = (line + 1) | 0;
            tp = (tp + (src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_N ? 4 : 2)) | 0;
            continue;
          }
          if (b2 === B_N) {
            out[op] = B_BACKSLASH; out[op + 1] = B_N;
            op = (op + 2) | 0; line = (line + 1) | 0; tp = (tp + 2) | 0;
            continue;
          }
          if (b2 === B_U) {
            const code = parseHex4(src, tp + 2);
            if (code === 10 || code === 13 || code === 34) return -1;
            out[op] = B_BACKSLASH; out[op + 1] = B_U;
            out[op + 2] = src[tp + 2]; out[op + 3] = src[tp + 3];
            out[op + 4] = src[tp + 4]; out[op + 5] = src[tp + 5];
            op = (op + 6) | 0; tp = (tp + 6) | 0;
            continue;
          }
          out[op] = B_BACKSLASH; out[op + 1] = b2;
          op = (op + 2) | 0; tp = (tp + 2) | 0;
        }

        if (closed) {
          const nb = src[tp];
          if (nb === B_COMMA) { out[op++] = B_QUOTE; tp = (tp + 1) | 0; ended = 0; }
          else if (nb === B_BACKSLASH && src[tp + 1] === B_N) { out[op++] = B_QUOTE; tp = (tp + 2) | 0; line = (line + 1) | 0; ended = 1; }
          else if (nb === B_BACKSLASH && src[tp + 1] === B_R && src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_N) { out[op++] = B_QUOTE; tp = (tp + 4) | 0; line = (line + 1) | 0; ended = 1; }
          else if (nb === B_QUOTE) { out[op++] = B_QUOTE; ended = 2; }
          else {
            const r = finishQuotedCold(src, inLen, tp, out, op, openTp, openLine, openOp, line, true, recordLine, rowIdx, ctx);
            if (r < 0) return -1;
            tp = ctx._tp; op = ctx._op; line = ctx._line; ended = r;
          }
        } else {
          const r = finishQuotedCold(src, inLen, tp, out, op, openTp, openLine, openOp, line, false, recordLine, rowIdx, ctx);
          if (r < 0) return -1;
          tp = ctx._tp; op = ctx._op; line = ctx._line; ended = r;
        }
      } else {
        quoted = false;
        out[op++] = B_QUOTE;

        while (true) {
          while (tp <= n4) {
            const w = sdv.getInt32(tp, true);
            ddv.setInt32(op, w, true);
            const x1 = w ^ 0x2c2c2c2c;
            const x2 = w ^ 0x5c5c5c5c;
            const x3 = w ^ 0x22222222;
            const m =
              ((((x1 - 0x01010101) | 0) & ~x1) |
                (((x2 - 0x01010101) | 0) & ~x2) |
                (((x3 - 0x01010101) | 0) & ~x3)) &
              SWAR_MASK;
            if (m === 0) {
              op = (op + 4) | 0;
              tp = (tp + 4) | 0;
            } else {
              const k = (31 - Math.clz32(m & -m)) >>> 3;
              op = (op + k) | 0;
              tp = (tp + k) | 0;
              break;
            }
          }
          if (tp > n4) {
            while (tp < inLen) {
              const b = src[tp];
              if (b === B_COMMA || b === B_BACKSLASH || b === B_QUOTE) break;
              out[op++] = b;
              tp = (tp + 1) | 0;
            }
          }

          const b = src[tp];
          if (b === B_COMMA) {
            tp = (tp + 1) | 0;
            const nf = (fieldCount + 1) | 0;
            if (nf < width && src[tp] !== B_BACKSLASH) {
              ddv.setInt32(op, 0x00222c22, true);
              op = (op + 3) | 0;
              fieldCount = nf;
              continue;
            }
            ended = 0;
            break;
          }
          if (b === B_QUOTE) { ended = 2; break; }
          const b2 = src[tp + 1];
          if (b2 === B_N) { tp = (tp + 2) | 0; line = (line + 1) | 0; ended = 1; break; }
          if (b2 === B_R) {
            if (src[tp + 2] === B_BACKSLASH && src[tp + 3] === B_N) {
              tp = (tp + 4) | 0; line = (line + 1) | 0; ended = 1; break;
            }
            pushSimpleErr(ctx, ERR_STRAY_CR, recordLine, rowIdx);
            tp = (tp + 2) | 0;
            continue;
          }
          if (b2 === B_U) {
            const code = parseHex4(src, tp + 2);
            if (code === 10 || code === 13 || code === 34 || code === 44) return -1;
            out[op] = B_BACKSLASH; out[op + 1] = B_U;
            out[op + 2] = src[tp + 2]; out[op + 3] = src[tp + 3];
            out[op + 4] = src[tp + 4]; out[op + 5] = src[tp + 5];
            op = (op + 6) | 0; tp = (tp + 6) | 0;
            continue;
          }
          out[op] = B_BACKSLASH; out[op + 1] = b2;
          op = (op + 2) | 0; tp = (tp + 2) | 0;
        }
        out[op++] = B_QUOTE;
      }

      fieldCount = (fieldCount + 1) | 0;
    } while (ended === 0);

    if (fieldCount === 1 && !quoted && op === ((lastFieldStartOp + 2) | 0)) {
      op = rowStartOp;
      continue;
    }

    if (fieldCount === width) {
      out[op++] = B_RBRACKET;
      dataRowCount = (dataRowCount + 1) | 0;
    } else {
      const wasFirst = width < 0;
      width = finishRowCold(ctx, out, op, width, fieldCount, recordLine, rowIdx, rowStartOp, extraStartOp);
      out = ctx.out;
      ddv = ctx.ddv;
      outLen = out.length;
      op = ctx._op;
      if (!wasFirst) dataRowCount = (dataRowCount + 1) | 0;
    }
  }

  ctx.op = op;
  ctx.width = width;
  ctx.dataRowCount = dataRowCount;
  return tp;
}

function makeCtx(out) {
  return {
    out,
    ddv: new DataView(out.buffer, out.byteOffset, out.byteLength),
    op: 0,
    width: -1,
    dataRowCount: 0,
    rec0Buf: null,
    prefixStart: -1,
    reserve: 0,
    errCodes: [],
    errLines: [],
    errRows: [],
    errFieldCnts: [],
    errExtraBufs: [],
    _tp: 0,
    _op: 0,
    _dl: 0,
    _line: 1,
  };
}

/**
 * Processes /input/cases.json UTF-8 Buffer into /output/answers.json UTF-8 Buffer in one streaming pass.
 * Each case is answered independently with zero cross-case state.
 */
export function runCasesBuffer(inBuf) {
  const inLen = inBuf.length;
  const src = new Uint8Array(inBuf.buffer, inBuf.byteOffset, inLen);
  const sdv = new DataView(inBuf.buffer, inBuf.byteOffset, inLen);

  const initSize = Math.max(65536, inLen + (inLen >>> 2) + 2 * 1024 * 1024);
  let out = Buffer.allocUnsafe(initSize);
  const ctx = makeCtx(out);

  let p = skipWs(src, 0, inLen);
  if (p >= inLen || src[p] !== B_LBRACKET) {
    const cases = JSON.parse(inBuf.toString('utf8'));
    const answers = [];
    for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
    return Buffer.from(JSON.stringify(answers), 'utf8');
  }
  p++;
  ctx.out[ctx.op++] = B_LBRACKET;

  let caseIdx = 0;

  while (true) {
    p = skipWs(src, p, inLen);
    if (p >= inLen || src[p] === B_RBRACKET) break;
    if (caseIdx > 0) {
      if (src[p] === B_COMMA) { p++; p = skipWs(src, p, inLen); }
      ctx.out[ctx.op++] = B_COMMA;
    }
    caseIdx++;

    if (src[p] !== B_LBRACE) {
      const cases = JSON.parse(inBuf.toString('utf8'));
      const answers = [];
      for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
      return Buffer.from(JSON.stringify(answers), 'utf8');
    }

    const caseObjStart = p;
    const caseOutStart = ctx.op;
    p++;

    let inputFound = false;
    let parseOk = true;
    let headerVal = false;
    let textFound = false;

    ctx.width = -1;
    ctx.dataRowCount = 0;
    ctx.rec0Buf = null;
    ctx.prefixStart = -1;
    ctx.reserve = 0;
    ctx.errCodes = [];
    ctx.errLines = [];
    ctx.errRows = [];
    ctx.errFieldCnts = [];
    ctx.errExtraBufs = [];

    while (p < inLen) {
      p = skipWs(src, p, inLen);
      if (src[p] === B_RBRACE) { p++; break; }
      if (src[p] === B_COMMA) { p++; p = skipWs(src, p, inLen); }
      if (src[p] !== B_QUOTE) { parseOk = false; break; }
      const kStart = p + 1;
      const kEndQ = skipJsonString(src, p, inLen);
      if (kEndQ < 0) { parseOk = false; break; }
      const kEnd = kEndQ - 1;
      p = skipWs(src, kEndQ, inLen);
      if (src[p] !== B_COLON) { parseOk = false; break; }
      p = skipWs(src, p + 1, inLen);

      if (keyEquals(src, kStart, kEnd, 'input')) {
        inputFound = true;
        if (src[p] !== B_LBRACE) { parseOk = false; break; }
        p++;

        while (p < inLen) {
          p = skipWs(src, p, inLen);
          if (src[p] === B_RBRACE) { p++; break; }
          if (src[p] === B_COMMA) { p++; p = skipWs(src, p, inLen); }
          if (src[p] !== B_QUOTE) { parseOk = false; break; }
          const ikStart = p + 1;
          const ikEndQ = skipJsonString(src, p, inLen);
          if (ikEndQ < 0) { parseOk = false; break; }
          const ikEnd = ikEndQ - 1;
          p = skipWs(src, ikEndQ, inLen);
          if (src[p] !== B_COLON) { parseOk = false; break; }
          p = skipWs(src, p + 1, inLen);

          if (keyEquals(src, ikStart, ikEnd, 'text')) {
            if (src[p] !== B_QUOTE || textFound) { parseOk = false; break; }
            textFound = true;
            const nextP = parseCaseText(src, sdv, inLen, p + 1, ctx);
            if (nextP < 0) { parseOk = false; break; }
            p = nextP;
          } else if (keyEquals(src, ikStart, ikEnd, 'header')) {
            if (src[p] === 116 && src[p + 1] === 114 && src[p + 2] === 117 && src[p + 3] === 101) {
              headerVal = true; p += 4;
            } else if (src[p] === 102 && src[p + 1] === 97 && src[p + 2] === 108 && src[p + 3] === 115 && src[p + 4] === 101) {
              headerVal = false; p += 5;
            } else {
              headerVal = false; p = skipJsonValue(src, p, inLen);
            }
          } else {
            p = skipJsonValue(src, p, inLen);
            if (p < 0) { parseOk = false; break; }
          }
        }
        if (!parseOk) break;
      } else {
        p = skipJsonValue(src, p, inLen);
        if (p < 0) { parseOk = false; break; }
      }
    }

    if (!parseOk || !inputFound || !textFound) {
      ctx.op = caseOutStart;
      const caseObjEnd = skipJsonValue(src, caseObjStart, inLen);
      const caseObj = JSON.parse(inBuf.toString('utf8', caseObjStart, caseObjEnd));
      const ans = run(caseObj.input);
      const ansBuf = Buffer.from(JSON.stringify(ans), 'utf8');
      if (ctx.op + ansBuf.length + 16 > ctx.out.length) growOutBuf(ctx, ctx.op, ctx.op + ansBuf.length + 65536);
      ansBuf.copy(ctx.out, ctx.op);
      ctx.op += ansBuf.length;
      p = caseObjEnd;
      continue;
    }

    out = ctx.out;
    let op = ctx.op;
    if (ctx.width < 0) {
      if (op + 1024 > out.length) { growOutBuf(ctx, op, op + 4096); out = ctx.out; }
      op = writeBytes(out, op, headerVal ? PFX_EMPTY_HDR : PFX_EMPTY_NOHDR);
    } else {
      let pp = ctx.prefixStart;
      if (headerVal) {
        pp = writeBytes(out, pp, PFX_COLS);
        ctx.rec0Buf.copy(out, pp);
        pp += ctx.rec0Buf.length;
        pp = writeBytes(out, pp, PFX_MID_ROWS);
      } else {
        pp = writeBytes(out, pp, PFX_NULL_ROWS);
        ctx.rec0Buf.copy(out, pp);
        pp += ctx.rec0Buf.length;
        if (ctx.dataRowCount > 0) out[pp++] = B_COMMA;
      }
      const reserveEnd = ctx.prefixStart + ctx.reserve;
      while (pp < reserveEnd) out[pp++] = B_SPACE;

      if (op + 64 > out.length) { growOutBuf(ctx, op, op + 4096); out = ctx.out; }
      op = writeBytes(out, op, SFX_ERRORS);
    }

    const errCodes = ctx.errCodes;
    const errLines = ctx.errLines;
    const errRows = ctx.errRows;
    const errFieldCnts = ctx.errFieldCnts;
    const errExtraBufs = ctx.errExtraBufs;
    const errCount = errCodes.length;

    for (let i = 0; i < errCount; i++) {
      const code = errCodes[i];
      const extraBuf = errExtraBufs[i];
      const need = 128 + (code === ERR_LONG_ROW ? extraBuf.length : 0);
      if (op + need > out.length) { growOutBuf(ctx, op, op + need + 65536); out = ctx.out; }
      if (i > 0) out[op++] = B_COMMA;
      op = writeBytes(out, op, ERR_PREFIXES[code]);
      op = writeUint(out, op, errLines[i]);
      op = writeBytes(out, op, STR_ROW);
      const rIdx = errRows[i];
      if (headerVal) {
        if (rIdx < 0) op = writeBytes(out, op, STR_NULL);
        else op = writeUint(out, op, rIdx);
      } else {
        op = writeUint(out, op, rIdx + 1);
      }
      if (code === ERR_SHORT_ROW) {
        op = writeBytes(out, op, STR_FIELDS);
        op = writeUint(out, op, errFieldCnts[i]);
      } else if (code === ERR_LONG_ROW) {
        op = writeBytes(out, op, STR_EXTRA);
        extraBuf.copy(out, op);
        op += extraBuf.length;
      }
      out[op++] = B_RBRACE;
    }

    if (op + 4 > out.length) { growOutBuf(ctx, op, op + 16); out = ctx.out; }
    out[op++] = B_RBRACKET;
    out[op++] = B_RBRACE;
    ctx.op = op;
  }

  if (ctx.op + 2 > ctx.out.length) growOutBuf(ctx, ctx.op, ctx.op + 16);
  ctx.out[ctx.op++] = B_RBRACKET;
  return ctx.out.subarray(0, ctx.op);
}

// Populate type feedback across all parser branches once at module load using a tiny 260-byte constant sample.
// Uses identical Uint8Array / Buffer / ctx maps as runCasesBuffer and keeps zero state between real cases.
(function primeFeedback() {
  const s1Buf = Buffer.from(
    '\uFEFFalpha_1234,bravo_5678\\r\\n\\n\\r\\n\\r\\r\\n\\"quoted_1234\\"\\"more\\r\\nline2\\rline3\\nline4\\\\end\\",\\"q_lf_1234\\"\\n\\"q_crlf_1234\\",\\"q_crlf2\\"\\r\\n\\"junk_1234\\"xy,stray\\rcr_1234\\r\\nshort_1234\\nlong1_1234,long2_1234,long3_1234\\nalpha_1234,bravo_5678,charlie_9\\n\\"unterm_1234"'
  );
  const src1 = new Uint8Array(s1Buf.buffer, s1Buf.byteOffset, s1Buf.byteLength);
  const sdv1 = new DataView(s1Buf.buffer, s1Buf.byteOffset, s1Buf.byteLength);
  const s2Buf = Buffer.from('alpha_1234,bravo_5678\\n\\"quoted_eof_1234\\",\\"quoted_eof2\\""');
  const src2 = new Uint8Array(s2Buf.buffer, s2Buf.byteOffset, s2Buf.byteLength);
  const sdv2 = new DataView(s2Buf.buffer, s2Buf.byteOffset, s2Buf.byteLength);
  const ctx = makeCtx(Buffer.allocUnsafe(81920));
  for (let k = 0; k < 40; k++) {
    ctx.op = 0; ctx.width = -1; ctx.dataRowCount = 0;
    ctx.errCodes = []; ctx.errLines = []; ctx.errRows = []; ctx.errFieldCnts = []; ctx.errExtraBufs = [];
    parseCaseText(src1, sdv1, src1.length, 0, ctx);
    ctx.op = 0; ctx.width = -1; ctx.dataRowCount = 0;
    ctx.errCodes = []; ctx.errLines = []; ctx.errRows = []; ctx.errFieldCnts = []; ctx.errExtraBufs = [];
    parseCaseText(src2, sdv2, src2.length, 0, ctx);
  }
})();

