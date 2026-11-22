// High-throughput drop-in replacement for csv-reader 1.0.0 (V20: 512 KiB L2-Hot Chunk-Streaming SWAR).
//   - 512 KiB SINGLE ArrayBuffer (256 KiB IN + 256 KiB OUT = 128 pages total, 100% L2-cache resident!)
//   - Zero-copy 33-byte Rec0 pwrite patch (24B pre + 9B post) enables true chunk-streaming before reading `"header"`
//   - 0x0000005c (`\` + 0,0,0) sentinel + 5-register tight nested 4B SWAR + --no-maglev single TurboFan compile
//   - Lean CJS engine (fallback `run()` lives in separate `fallback.cjs`, never parsed on hot path)

const fs = process.getBuiltinModule('node:fs');
const { openSync, readSync, writeSync, closeSync } = fs;

const ERR_STRAY_CR = 0;
const ERR_UNTERMINATED = 1;
const ERR_QUOTE_JUNK = 2;
const ERR_SHORT_ROW = 3;
const ERR_LONG_ROW = 4;

const IN_CAP = 262144;    // 256 KiB L2-hot input window (+16B sentinel slack)
const IN_READ = 262128;
const OUT_CAP = 262144;   // 256 KiB L2-hot output window
const FLUSH_AT = 196608;  // 192 KiB flush threshold (leaves 64 KiB single-row headroom)
const SAFE_OUT = 245760;  // 240 KiB overflow guard

const MEM = new ArrayBuffer(IN_CAP + OUT_CAP); // 512 KiB total = 128 x 4 KiB pages!
const IN_BUF = Buffer.from(MEM, 0, IN_CAP);
const IN_U8 = new Uint8Array(MEM, 0, IN_CAP);
const IN_DV = new DataView(MEM, 0, IN_CAP);
const OUT_BUF = Buffer.from(MEM, IN_CAP, OUT_CAP);
const OUT_U8 = new Uint8Array(MEM, IN_CAP, OUT_CAP);
const OUT_DV = new DataView(MEM, IN_CAP, OUT_CAP);

// ST[0]=op, ST[1]=width, ST[2]=recCount, ST[3]=ofd, ST[4]=coldTp, ST[5]=coldOp,
// ST[6]=coldLine, ST[7]=line, ST[8]=outFilePos, ST[9]=casePreOff, ST[10]=casePostOff,
// ST[11..14]=recStart(tp, line, op, errLen)
const ST = new Int32Array(16);
const WAIT_I32 = new Int32Array(new SharedArrayBuffer(4));

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

const PRE_HDR = Buffer.from('             {"columns":');         // 24 bytes
const PRE_NOHDR = Buffer.from('{"columns":null,"rows":[');       // 24 bytes
const POST_HDR = Buffer.from(',"rows":[');                       // 9 bytes
const POST_NOHDR_MORE = Buffer.from(',        ');                // 9 bytes
const POST_NOHDR_ONLY = Buffer.from('         ');                // 9 bytes
const PFX_EMPTY_HDR = Buffer.from('{"columns":[],"rows":[],"errors":[');
const PFX_EMPTY_NOHDR = Buffer.from('{"columns":null,"rows":[],"errors":[');
const SFX_ERRORS = Buffer.from('],"errors":[');
const ERR_PFX_STR = [
  '{"code":"stray_cr","line":',
  '{"code":"unterminated_quote","line":',
  '{"code":"quote_junk","line":',
  '{"code":"short_row","line":',
  '{"code":"long_row","line":',
];

let errCodes = [], errLines = [], errRows = [], errFieldCnts = [], errExtraBufs = [];
function resetErrors() {
  errCodes = []; errLines = []; errRows = []; errFieldCnts = []; errExtraBufs = [];
}
function rollbackRecCold(width, recCount) {
  const n = ST[14];
  errCodes.length = n; errLines.length = n; errRows.length = n;
  errFieldCnts.length = n; errExtraBufs.length = n;
  ST[0] = ST[13]; ST[1] = width; ST[2] = recCount; ST[7] = ST[12];
  return ST[11];
}

function flushOutCold(op) {
  const ofd = ST[3];
  if (ofd < 0 || op <= 0) return;
  let pos = ST[8];
  let woff = 0;
  while (woff < op) {
    const n = writeSync(ofd, OUT_U8, woff, op - woff, pos + woff);
    woff += n;
  }
  ST[8] = pos + op;
}

function writeRowPrefixCold(op) {
  // Reserve 24-byte slot before Rec0; patched at end of case once `header` is known.
  ST[9] = ST[8] + op;
  return op + 24;
}

function pushSimpleErr(code, line, rowIdx) {
  errCodes.push(code); errLines.push(line); errRows.push(rowIdx);
  errFieldCnts.push(0); errExtraBufs.push(null);
}

function copyUnicodeCold(tp, op, checkComma) {
  const code = parseHex4(IN_U8, tp + 2);
  if (code === 10 || code === 13 || code === 34 || (checkComma && code === 44)) return -1;
  OUT_U8[op] = 92; OUT_U8[op + 1] = 117;
  OUT_U8[op + 2] = IN_U8[tp + 2]; OUT_U8[op + 3] = IN_U8[tp + 3];
  OUT_U8[op + 4] = IN_U8[tp + 4]; OUT_U8[op + 5] = IN_U8[tp + 5];
  return op + 6;
}

function scanUnquotedSlow(textEnd, tp, op, recordLine, rowIdx, isFinalChunk) {
  let dl = 0, ended = 2;
  while (tp < textEnd) {
    if (op >= SAFE_OUT) return -2;
    const b = IN_U8[tp];
    if (b !== 44 && b !== 92) { OUT_U8[op++] = b; tp++; continue; }
    if (b === 44) { tp++; ended = 0; break; }
    const b2 = IN_U8[tp + 1];
    if (b2 === 110) { tp += 2; dl = 1; ended = 1; break; }
    if (b2 === 114) {
      if (IN_U8[tp + 2] === 92 && IN_U8[tp + 3] === 110) { tp += 4; dl = 1; ended = 1; break; }
      pushSimpleErr(ERR_STRAY_CR, recordLine, rowIdx);
      tp += 2; continue;
    }
    if (b2 === 117) {
      const nextOp = copyUnicodeCold(tp, op, true);
      if (nextOp < 0) return -1;
      op = nextOp; tp += 6; continue;
    }
    OUT_U8[op] = 92; OUT_U8[op + 1] = b2;
    op += 2; tp += 2;
  }
  if (ended === 2 && !isFinalChunk) return -3;
  ST[4] = tp; ST[5] = op; ST[6] = dl;
  return ended;
}

function finishQuotedCold(textEnd, tp, op, openTp, openLine, openOp, line, closed, recordLine, rowIdx, isFinalChunk) {
  if (!closed) {
    tp = openTp + 2; line = openLine; op = openOp;
    pushSimpleErr(ERR_UNTERMINATED, recordLine, rowIdx);
    OUT_U8[op] = 34; OUT_U8[op + 1] = 92; OUT_U8[op + 2] = 34;
    op += 3;
    const r = scanUnquotedSlow(textEnd, tp, op, recordLine, rowIdx, isFinalChunk);
    if (r < 0) return r;
    OUT_U8[ST[5]++] = 34;
    ST[6] = line + ST[6];
    return r;
  }
  const opBeforeJunk = op;
  const r = scanUnquotedSlow(textEnd, tp, op, recordLine, rowIdx, isFinalChunk);
  if (r < 0) return r;
  if (ST[5] > opBeforeJunk) pushSimpleErr(ERR_QUOTE_JUNK, recordLine, rowIdx);
  OUT_U8[ST[5]++] = 34;
  ST[6] = line + ST[6];
  return r;
}

function finishRowCold(op, width, fieldCount, recordLine, rowIdx, extraStartOp) {
  if (width < 0) {
    OUT_U8[op++] = 93;
    ST[10] = ST[8] + op; // Reserve 9-byte separator slot right after Rec0!
    op += 9;
    ST[5] = op;
    return fieldCount;
  }
  if (fieldCount < width) {
    errCodes.push(ERR_SHORT_ROW); errLines.push(recordLine); errRows.push(rowIdx);
    errFieldCnts.push(fieldCount); errExtraBufs.push(null);
    for (let k = fieldCount; k < width; k++) {
      OUT_U8[op] = 44; OUT_U8[op + 1] = 34; OUT_U8[op + 2] = 34;
      op += 3;
    }
    OUT_U8[op++] = 93;
  } else {
    OUT_U8[op++] = 93;
    errCodes.push(ERR_LONG_ROW); errLines.push(recordLine); errRows.push(rowIdx);
    errFieldCnts.push(0); errExtraBufs.push(Buffer.from(OUT_U8.subarray(extraStartOp, op)));
    op = extraStartOp;
  }
  ST[5] = op;
  return width;
}

// ============================================================================
// L2-HOT 512 KiB CHUNK-STREAMING SENTINEL SWAR KERNEL!
// Caller guarantees 0x0000005c (`\` + 0,0,0) sentinel at IN_U8[textEnd..textEnd+3].
// Tight 5-register nested 4B SWAR + zero bounds checks + clean chunk-boundary exit/rollback.
// ============================================================================
function csvParse(tp, textEnd, stopFast, isFinalChunk) {
  const inU8 = IN_U8, inDv = IN_DV, outU8 = OUT_U8, outDv = OUT_DV;
  let op = ST[0] | 0;
  let width = ST[1] | 0;
  let widthMinus1 = (width - 1) | 0;
  let recCount = ST[2] | 0;
  let line = ST[7] | 0;

  while (tp < stopFast) {
    while (inU8[tp] === 92) {
      const b2 = inU8[(tp + 1) | 0];
      if (b2 === 110) { tp = (tp + 2) | 0; line = (line + 1) | 0; }
      else if (b2 === 114 && inU8[(tp + 2) | 0] === 92 && inU8[(tp + 3) | 0] === 110) { tp = (tp + 4) | 0; line = (line + 1) | 0; }
      else if (b2 === 117) {
        const code = parseHex4(inU8, (tp + 2) | 0);
        if (code === 10 || code === 13 || code === 34 || code === 44) return -1;
        break;
      } else break;
    }
    if (tp >= stopFast) break;

    if (op >= 196608) {
      flushOutCold(op);
      op = 0;
    }

    ST[11] = tp; ST[12] = line; ST[13] = op; ST[14] = errCodes.length | 0;
    let recordLine = line;
    let rowIdx = recCount;
    let rowStartOp = op;

    if (width < 0) op = writeRowPrefixCold(op) | 0;
    else if (recCount > 1) outU8[op++] = 44;
    outU8[op++] = 91;

    let fieldCount = 0, quoted = false, ended = 0, lastFieldStartOp = 0, extraStartOp = -1;

    do {
      if (op >= 245760) return -2;
      if (fieldCount === width) { outU8[op++] = 93; extraStartOp = op; outU8[op++] = 91; }
      else if (fieldCount > 0) outU8[op++] = 44;

      lastFieldStartOp = op;
      if (inU8[tp] === 92 && inU8[(tp + 1) | 0] === 34) {
        quoted = true;
        const openTp = tp, openLine = line, openOp = op;
        outU8[op++] = 34;
        tp = (tp + 2) | 0;
        let closed = false;

        while (true) {
          let m = 0;
          while (true) {
            const w = inDv.getInt32(tp, true);
            outDv.setInt32(op, w, true);
            const x = w ^ 0x5c5c5c5c;
            m = (((x - 0x01010101) | 0) & ~x) & -2139062144;
            if (m !== 0) break;
            op = (op + 4) | 0; tp = (tp + 4) | 0;
          }
          const k = (31 - Math.clz32(m & -m)) >>> 3;
          op = (op + k) | 0; tp = (tp + k) | 0;
          const b2 = inU8[(tp + 1) | 0];
          if (b2 === 34) {
            if (inU8[(tp + 2) | 0] === 92 && inU8[(tp + 3) | 0] === 34) {
              outU8[op] = 92; outU8[(op + 1) | 0] = 34; op = (op + 2) | 0; tp = (tp + 4) | 0;
              continue;
            }
            tp = (tp + 2) | 0; closed = true; break;
          }
          if (b2 === 110 || b2 === 114) {
            outU8[op] = 92; outU8[(op + 1) | 0] = 110; op = (op + 2) | 0; line = (line + 1) | 0;
            tp = (tp + (b2 === 114 && inU8[(tp + 2) | 0] === 92 && inU8[(tp + 3) | 0] === 110 ? 4 : 2)) | 0;
            continue;
          }
          if (tp >= textEnd) {
            if (!isFinalChunk) return rollbackRecCold(width, recCount);
            break;
          }
          if (b2 === 117) {
            const nop = copyUnicodeCold(tp, op, false) | 0;
            if (nop < 0) return -1;
            op = nop; tp = (tp + 6) | 0; continue;
          }
          outU8[op] = 92; outU8[(op + 1) | 0] = b2; op = (op + 2) | 0; tp = (tp + 2) | 0;
        }

        let needCold = !closed;
        if (closed) {
          const nb = inU8[tp];
          if (nb === 44) { outU8[op++] = 34; tp = (tp + 1) | 0; ended = 0; }
          else if (nb === 92) {
            const nb2 = inU8[(tp + 1) | 0];
            if (nb2 === 110) { outU8[op++] = 34; tp = (tp + 2) | 0; line = (line + 1) | 0; ended = 1; }
            else if (nb2 === 114 && inU8[(tp + 2) | 0] === 92 && inU8[(tp + 3) | 0] === 110) {
              outU8[op++] = 34; tp = (tp + 4) | 0; line = (line + 1) | 0; ended = 1;
            } else if (tp >= textEnd) {
              if (!isFinalChunk) return rollbackRecCold(width, recCount);
              outU8[op++] = 34; ended = 2;
            } else needCold = true;
          } else needCold = true;
        }
        if (needCold) {
          const r = finishQuotedCold(textEnd, tp, op, openTp, openLine, openOp, line, closed, recordLine, rowIdx, isFinalChunk) | 0;
          if (r === -3) return rollbackRecCold(width, recCount);
          if (r < 0) return r;
          tp = ST[4]; op = ST[5]; line = ST[6]; ended = r;
        }
      } else {
        quoted = false;
        outU8[op++] = 34;

        while (true) {
          let m = 0;
          while (true) {
            const w = inDv.getInt32(tp, true);
            outDv.setInt32(op, w, true);
            const x1 = w ^ 0x2c2c2c2c;
            const x2 = w ^ 0x5c5c5c5c;
            m = ((((x1 - 0x01010101) | 0) & ~x1) | (((x2 - 0x01010101) | 0) & ~x2)) & -2139062144;
            if (m !== 0) break;
            op = (op + 4) | 0; tp = (tp + 4) | 0;
          }
          const k = (31 - Math.clz32(m & -m)) >>> 3;
          op = (op + k) | 0; tp = (tp + k) | 0;
          if (inU8[tp] === 44) {
            tp = (tp + 1) | 0;
            const nf = (fieldCount + 1) | 0;
            if (nf < width && inU8[tp] !== 92) {
              outDv.setInt32(op, 0x00222c22, true); // `","`
              op = (op + 3) | 0; fieldCount = nf;
              continue;
            }
            ended = 0; break;
          }
          const b2 = inU8[(tp + 1) | 0];
          let eolStep = 0;
          if (b2 === 110) eolStep = 2;
          else if (b2 === 114) {
            if (inU8[(tp + 2) | 0] === 92 && inU8[(tp + 3) | 0] === 110) eolStep = 4;
            else { pushSimpleErr(0, recordLine, rowIdx); tp = (tp + 2) | 0; continue; }
          }
          if (eolStep > 0) {
            tp = (tp + eolStep) | 0; line = (line + 1) | 0;
            if (fieldCount === widthMinus1) {
              const nb = inU8[tp];
              if (nb !== 92 && nb !== 44 && op < 196608 && tp < stopFast) {
                recCount = (recCount + 1) | 0;
                outDv.setInt32(op, 0x5b2c5d22, true); // `"],[`
                outU8[(op + 4) | 0] = 34;
                op = (op + 5) | 0;
                fieldCount = 0; recordLine = line; rowIdx = recCount;
                ST[11] = tp; ST[12] = line; ST[13] = (op - 3) | 0; ST[14] = errCodes.length | 0;
                continue;
              }
            }
            ended = 1; break;
          }
          if (tp >= textEnd) {
            if (!isFinalChunk) return rollbackRecCold(width, recCount);
            ended = 2; break;
          }
          if (b2 === 117) {
            const nop = copyUnicodeCold(tp, op, true) | 0;
            if (nop < 0) return -1;
            op = nop; tp = (tp + 6) | 0; continue;
          }
          outU8[op] = 92; outU8[(op + 1) | 0] = b2; op = (op + 2) | 0; tp = (tp + 2) | 0;
        }
        outU8[op++] = 34;
      }

      fieldCount = (fieldCount + 1) | 0;
    } while (ended === 0);

    if (fieldCount === 1 && !quoted && op === ((lastFieldStartOp + 2) | 0)) {
      op = rowStartOp;
      continue;
    }

    if (fieldCount === width) {
      outU8[op++] = 93;
      recCount = (recCount + 1) | 0;
    } else {
      width = finishRowCold(op, width, fieldCount, recordLine, rowIdx, extraStartOp) | 0;
      widthMinus1 = (width - 1) | 0;
      op = ST[5];
      recCount = (recCount + 1) | 0;
    }
  }

  ST[0] = op; ST[1] = width; ST[2] = recCount; ST[7] = line;
  return tp;
}

// ============================================================================
// Streaming File-to-File Driver (512 KiB L2-Hot!)
// ============================================================================
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
    let depth = 1; p++;
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
  for (let i = 0; i < str.length; i++) if (buf[start + i] !== str.charCodeAt(i)) return false;
  return true;
}

function findTextEndAndHeader(textStart, validLen) {
  let pos = textStart;
  while (pos < validLen) {
    const rbrace = IN_BUF.indexOf(125, pos);
    if (rbrace < 0 || rbrace >= validLen) return null;
    let hdr = false, qPos = -1;
    if (
      rbrace >= textStart + 15 &&
      IN_U8[rbrace - 1] === 101 && IN_U8[rbrace - 2] === 117 && IN_U8[rbrace - 3] === 114 && IN_U8[rbrace - 4] === 116 &&
      IN_U8[rbrace - 5] === 58 && IN_U8[rbrace - 6] === 34 && IN_U8[rbrace - 7] === 114 && IN_U8[rbrace - 8] === 101 &&
      IN_U8[rbrace - 9] === 100 && IN_U8[rbrace - 10] === 97 && IN_U8[rbrace - 11] === 101 && IN_U8[rbrace - 12] === 104 &&
      IN_U8[rbrace - 13] === 34 && IN_U8[rbrace - 14] === 44 && IN_U8[rbrace - 15] === 34
    ) { hdr = true; qPos = rbrace - 15; }
    else if (
      rbrace >= textStart + 16 &&
      IN_U8[rbrace - 1] === 101 && IN_U8[rbrace - 2] === 115 && IN_U8[rbrace - 3] === 108 && IN_U8[rbrace - 4] === 97 &&
      IN_U8[rbrace - 5] === 102 && IN_U8[rbrace - 6] === 58 && IN_U8[rbrace - 7] === 34 && IN_U8[rbrace - 8] === 114 &&
      IN_U8[rbrace - 9] === 101 && IN_U8[rbrace - 10] === 100 && IN_U8[rbrace - 11] === 97 && IN_U8[rbrace - 12] === 101 &&
      IN_U8[rbrace - 13] === 104 && IN_U8[rbrace - 14] === 34 && IN_U8[rbrace - 15] === 44 && IN_U8[rbrace - 16] === 34
    ) { hdr = false; qPos = rbrace - 16; }
    if (qPos >= textStart) {
      let bs = 0, k = qPos - 1;
      while (k >= textStart && IN_U8[k] === 92) { bs++; k--; }
      if ((bs & 1) === 0) return { textEnd: qPos, headerVal: hdr, afterInput: rbrace + 1 };
    }
    pos = rbrace + 1;
  }
  return null;
}

function patchSlot(fileOff, buf, op) {
  const outPos = ST[8];
  if (fileOff >= outPos && (fileOff - outPos + buf.length) <= op) {
    OUT_U8.set(buf, fileOff - outPos);
    return op;
  }
  if (fileOff + buf.length > outPos) {
    flushOutCold(op);
    op = 0;
  }
  const ofd = ST[3];
  if (ofd >= 0) {
    let woff = 0;
    while (woff < buf.length) woff += writeSync(ofd, buf, woff, buf.length - woff, fileOff + woff);
  }
  return op;
}

function writeErrorsAndCloseCase(headerVal) {
  let op = ST[0];
  const recCount = ST[2];
  if (recCount > 0) {
    op = patchSlot(ST[9], headerVal ? PRE_HDR : PRE_NOHDR, op);
    op = patchSlot(ST[10], headerVal ? POST_HDR : (recCount > 1 ? POST_NOHDR_MORE : POST_NOHDR_ONLY), op);
    if (op >= FLUSH_AT) { flushOutCold(op); op = 0; }
    OUT_U8.set(SFX_ERRORS, op); op += SFX_ERRORS.length;
  } else {
    if (op >= FLUSH_AT) { flushOutCold(op); op = 0; }
    const pfx = headerVal ? PFX_EMPTY_HDR : PFX_EMPTY_NOHDR;
    OUT_U8.set(pfx, op); op += pfx.length;
  }

  const errCount = errCodes.length;
  if (errCount > 0) {
    let chunk = '';
    for (let i = 0; i < errCount; i++) {
      const code = errCodes[i];
      const rawIdx = errRows[i];
      const rowStr = headerVal ? (rawIdx === 0 ? 'null' : '' + (rawIdx - 1)) : '' + rawIdx;
      const pfx = (i > 0 ? ',' : '') + ERR_PFX_STR[code] + errLines[i] + ',"row":' + rowStr;
      if (code === ERR_LONG_ROW) {
        const extraBuf = errExtraBufs[i];
        chunk += pfx + ',"extra":';
        if (op + chunk.length + extraBuf.length + 16 > OUT_CAP) { flushOutCold(op); op = 0; }
        if (chunk.length > 0) { op += OUT_BUF.latin1Write(chunk, op); chunk = ''; }
        if (extraBuf.length + 16 > OUT_CAP) {
          flushOutCold(op); op = 0;
          const ofd = ST[3];
          let pos = ST[8], woff = 0;
          while (woff < extraBuf.length) woff += writeSync(ofd, extraBuf, woff, extraBuf.length - woff, pos + woff);
          ST[8] = pos + extraBuf.length;
          OUT_U8[op++] = 125;
        } else {
          OUT_U8.set(extraBuf, op); op += extraBuf.length; OUT_U8[op++] = 125;
        }
      } else if (code === ERR_SHORT_ROW) {
        chunk += pfx + ',"fields":' + errFieldCnts[i] + '}';
      } else {
        chunk += pfx + '}';
      }
      if (chunk.length > 32768) {
        if (op + chunk.length + 16 > OUT_CAP) { flushOutCold(op); op = 0; }
        op += OUT_BUF.latin1Write(chunk, op); chunk = '';
      }
    }
    if (chunk.length > 0) {
      if (op + chunk.length + 16 > OUT_CAP) { flushOutCold(op); op = 0; }
      op += OUT_BUF.latin1Write(chunk, op);
    }
  }

  if (op + 8 > OUT_CAP) { flushOutCold(op); op = 0; }
  OUT_U8[op++] = 93;
  OUT_U8[op++] = 125;
  ST[0] = op;
}

function runCasesFiles(inputPath, outputPath) {
  const ifd = openSync(inputPath, 'r');
  const ofd = openSync(outputPath, 'w');
  ST[0] = 0; ST[3] = ofd; ST[8] = 0;

  let validLen = 0, eof = false, filePos = 0;
  function fillWindow(keepFrom) {
    if (keepFrom > 0) {
      const rem = validLen - keepFrom;
      if (rem > 0) IN_U8.copyWithin(0, keepFrom, validLen);
      validLen = rem;
    }
    while (!eof && validLen < IN_READ) {
      const n = readSync(ifd, IN_BUF, validLen, IN_READ - validLen, filePos);
      if (n <= 0) { eof = true; break; }
      validLen += n;
      filePos += n;
    }
    return 0;
  }

  let p = fillWindow(0);

  function fallbackFullFile() {
    closeSync(ifd);
    closeSync(ofd);
    const { run } = require('./fallback.cjs');
    const cases = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const answers = [];
    for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
    fs.writeFileSync(outputPath, JSON.stringify(answers), 'utf8');
  }

  p = skipWs(IN_U8, p, validLen);
  if (p >= validLen || IN_U8[p] !== 91) { fallbackFullFile(); return; }
  p++;
  OUT_U8[0] = 91;
  ST[0] = 1;

  let caseIdx = 0;
  while (true) {
    if (!eof && (validLen - p) < 4096) p = fillWindow(p);
    p = skipWs(IN_U8, p, validLen);
    if (p >= validLen || IN_U8[p] === 93) break;
    if (caseIdx > 0) {
      if (IN_U8[p] === 44) { p++; p = skipWs(IN_U8, p, validLen); }
      if (ST[0] >= FLUSH_AT) { flushOutCold(ST[0]); ST[0] = 0; }
      OUT_U8[ST[0]++] = 44;
    }
    caseIdx++;

    if (IN_U8[p] !== 123) { fallbackFullFile(); return; }
    p++;

    let streamedDone = false, parseOk = false, headerVal = false, textStart = -1, textEnd = -1;
    ST[1] = -1; ST[2] = 0; ST[7] = 1;
    resetErrors();

    while (p < validLen) {
      if (!eof && (validLen - p) < 4096) p = fillWindow(p);
      p = skipWs(IN_U8, p, validLen);
      if (IN_U8[p] === 125) { p++; break; }
      if (IN_U8[p] === 44) { p++; p = skipWs(IN_U8, p, validLen); }
      if (IN_U8[p] !== 34) break;
      const kStart = p + 1, kEndQ = skipJsonString(IN_U8, p, validLen);
      if (kEndQ < 0) break;
      const kEnd = kEndQ - 1;
      p = skipWs(IN_U8, kEndQ, validLen);
      if (IN_U8[p] !== 58) break;
      p = skipWs(IN_U8, p + 1, validLen);

      if (keyEquals(IN_U8, kStart, kEnd, 'input')) {
        if (IN_U8[p] !== 123) break;
        p++;
        while (p < validLen) {
          if (!eof && (validLen - p) < 4096) p = fillWindow(p);
          p = skipWs(IN_U8, p, validLen);
          if (IN_U8[p] === 125) { p++; break; }
          if (IN_U8[p] === 44) { p++; p = skipWs(IN_U8, p, validLen); }
          if (IN_U8[p] !== 34) break;
          const ikStart = p + 1, ikEndQ = skipJsonString(IN_U8, p, validLen);
          if (ikEndQ < 0) break;
          const ikEnd = ikEndQ - 1;
          p = skipWs(IN_U8, ikEndQ, validLen);
          if (IN_U8[p] !== 58) break;
          p = skipWs(IN_U8, p + 1, validLen);

          if (keyEquals(IN_U8, ikStart, ikEnd, 'text')) {
            if (IN_U8[p] !== 34) break;
            if (!eof && (validLen - p) < 4096) p = fillWindow(p);
            let tp = p + 1;
            // Strip leading UTF-8 BOM or \uFEFF once at start of text
            if (tp + 2 < validLen && IN_U8[tp] === 239 && IN_U8[tp + 1] === 187 && IN_U8[tp + 2] === 191) tp += 3;
            else if (tp + 5 < validLen && IN_U8[tp] === 92 && IN_U8[tp + 1] === 117 && parseHex4(IN_U8, tp + 2) === 0xfeff) tp += 6;

            // Check if fast streaming format (`","header":true/false}`) applies or if whole file is in RAM (eof)
            let fast = findTextEndAndHeader(tp, validLen);
            if (!fast && eof) {
              // Entire file is in RAM and not compact `","header":...}` -> non-compact JSON (pretty/swapped/extra)
              const endQ = skipJsonString(IN_U8, p, validLen);
              if (endQ < 0) { fallbackFullFile(); return; }
              textStart = tp; textEnd = endQ - 1; p = endQ; parseOk = true;
              continue;
            }

            // TRUE 256 KiB L2-HOT CHUNK-STREAMING LOOP!
            while (true) {
              if (fast) {
                const te = fast.textEnd;
                const saved4 = IN_DV.getInt32(te, true);
                IN_DV.setInt32(te, 0x0000005c, true);
                const r = csvParse(tp, te, te, true);
                IN_DV.setInt32(te, saved4, true);
                if (r < 0) { fallbackFullFile(); return; }
                headerVal = fast.headerVal;
                p = fast.afterInput;
                streamedDone = true;
                break;
              }
              if (eof) { fallbackFullFile(); return; }
              const chunkEnd = validLen - 8;
              const stopFast = validLen - 4096;
              if (tp < stopFast) {
                const saved4 = IN_DV.getInt32(chunkEnd, true);
                IN_DV.setInt32(chunkEnd, 0x0000005c, true);
                const nextTp = csvParse(tp, chunkEnd, stopFast, false);
                IN_DV.setInt32(chunkEnd, saved4, true);
                if (nextTp < 0 || (nextTp === 0 && tp === 0)) { fallbackFullFile(); return; }
                tp = fillWindow(nextTp);
              } else {
                tp = fillWindow(tp);
              }
              fast = findTextEndAndHeader(tp, validLen);
            }
            break;
          } else if (keyEquals(IN_U8, ikStart, ikEnd, 'header')) {
            if (IN_U8[p] === 116 && IN_U8[p + 1] === 114 && IN_U8[p + 2] === 117 && IN_U8[p + 3] === 101) { headerVal = true; p += 4; }
            else if (IN_U8[p] === 102 && IN_U8[p + 1] === 97 && IN_U8[p + 2] === 108 && IN_U8[p + 3] === 115 && IN_U8[p + 4] === 101) { headerVal = false; p += 5; }
            else { headerVal = false; p = skipJsonValue(IN_U8, p, validLen); }
          } else {
            p = skipJsonValue(IN_U8, p, validLen);
            if (p < 0) { parseOk = false; break; }
          }
        }
        if (streamedDone) {
          if (!eof && (validLen - p) < 64) p = fillWindow(p);
          p = skipWs(IN_U8, p, validLen);
          if (IN_U8[p] === 125) p++;
          else { fallbackFullFile(); return; }
          break;
        }
      } else {
        p = skipJsonValue(IN_U8, p, validLen);
        if (p < 0) break;
      }
    }

    if (streamedDone) {
      writeErrorsAndCloseCase(headerVal);
    } else if (parseOk && textStart >= 0 && textEnd >= textStart) {
      const saved4 = IN_DV.getInt32(textEnd, true);
      IN_DV.setInt32(textEnd, 0x0000005c, true);
      const r = csvParse(textStart, textEnd, textEnd, true);
      IN_DV.setInt32(textEnd, saved4, true);
      if (r < 0) { fallbackFullFile(); return; }
      writeErrorsAndCloseCase(headerVal);
    } else {
      fallbackFullFile(); return;
    }
  }

  if (ST[0] + 4 > OUT_CAP) { flushOutCold(ST[0]); ST[0] = 0; }
  OUT_U8[ST[0]++] = 93;
  flushOutCold(ST[0]);
  closeSync(ifd);
  closeSync(ofd);
}

function primeCsv(waitMs = 120) {
  const s1 = 'alpha_1234,bravo_5678\\r\\n\\n\\r\\n\\r\\r\\nplain_1234,plain_5678\\r\\nplain_aaaa,plain_bbbb\\nplain_cccc,plain_dddd\\n\\"quoted_1234\\"\\"more\\r\\nline2\\rline3\\nline4\\\\end\\",\\"q_lf_1234\\"\\n\\"q_crlf_1234\\",\\"q_crlf2\\"\\r\\n\\"junk_1234\\"xy,stray\\rcr_1234\\r\\nshort_1234\\nlong1_1234,long2_1234,long3_1234\\n\\"unterm_1234_xy';
  const s2 = 'alpha_1234,bravo_5678\\n\\"quoted_eof_1234\\",\\"quoted_eof2\\"';
  const s3 = 'alpha_1234,bravo_5678\\nmid\\"q,eof_tail_xy';
  const n1 = IN_BUF.write(s1, 0, 'utf8');
  IN_DV.setInt32(n1, 0x0000005c, true);
  const n2 = IN_BUF.write(s2, 512, 'utf8');
  IN_DV.setInt32(512 + n2, 0x0000005c, true);
  const n3 = IN_BUF.write(s3, 1024, 'utf8');
  IN_DV.setInt32(1024 + n3, 0x0000005c, true);

  ST[3] = -1; ST[8] = 0;
  for (let k = 0; k < 2; k++) {
    ST[0] = FLUSH_AT; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(0, n1, n1, true);
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(512, 512 + n2, 512 + n2, true);
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(1024, 1024 + n3, 1024 + n3, true);
    // Also warm the `!isFinalChunk` chunk-boundary exit & rollback paths!
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(0, n1, n1 - 40, false);
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(512, 512 + n2, 512 + n2, false);
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(1024, 1024 + n3, 1024 + n3, false);
  }
  for (let k = 0; k < 32; k++) {
    ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(0, n1, n1, true);
  }
  Atomics.wait(WAIT_I32, 0, 0, waitMs);
  ST[0] = 0; ST[1] = -1; ST[2] = 0; ST[7] = 1; resetErrors(); csvParse(512, 512 + n2, 512 + n2, true);
  resetErrors();
}

module.exports = { runCasesFiles, primeCsv };
