// Reference-exact pure-JS run(input) for solve.js ESM export & rare fallback.
function run(input) {
  const text = String(input.text), header = input.header === true, len = text.length;
  const errors = [], rows = [];
  let columns = null, width = -1, pos = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0, line = 1;
  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos++; line++; }
      else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= len) break;
    const recordLine = line, recordRow = header && columns === null ? null : rows.length, fields = [];
    let quoted = false, ended = 0;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      let val = '';
      if (!quoted) {
        let start = pos, hasStray = false; ended = 2;
        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c === 44) { val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos); pos++; ended = 0; break; }
          if (c === 10) { val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos); pos++; line++; ended = 1; break; }
          if (c === 13) {
            if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos); pos += 2; line++; ended = 1; break; }
            val += text.slice(start, pos); errors.push({ code: 'stray_cr', line: recordLine, row: recordRow }); pos++; start = pos; hasStray = true; continue;
          }
          pos++;
        }
        if (ended === 2) val = hasStray ? val + text.slice(start, pos) : text.slice(start, pos);
      } else {
        const open = pos, openLine = line; pos++;
        let start = pos, hasSpecial = false, closed = false;
        while (pos < len) {
          const c = text.charCodeAt(pos);
          if (c === 34) {
            if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) { val += text.slice(start, pos + 1); pos += 2; start = pos; hasSpecial = true; continue; }
            val = hasSpecial ? val + text.slice(start, pos) : text.slice(start, pos); pos++; closed = true; break;
          }
          if (c === 13) { val += text.slice(start, pos) + '\n'; line++; pos += pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? 2 : 1; start = pos; hasSpecial = true; continue; }
          if (c === 10) line++;
          pos++;
        }
        if (!closed) {
          pos = open + 1; line = openLine; errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          val = '"'; let start2 = pos; ended = 2;
          while (pos < len) {
            const c = text.charCodeAt(pos);
            if (c === 44) { val += text.slice(start2, pos); pos++; ended = 0; break; }
            if (c === 10) { val += text.slice(start2, pos); pos++; line++; ended = 1; break; }
            if (c === 13) {
              if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { val += text.slice(start2, pos); pos += 2; line++; ended = 1; break; }
              val += text.slice(start2, pos); errors.push({ code: 'stray_cr', line: recordLine, row: recordRow }); pos++; start2 = pos; continue;
            }
            pos++;
          }
          if (ended === 2) val += text.slice(start2, pos);
        } else if (pos >= len) { ended = 2; }
        else {
          const nc = text.charCodeAt(pos);
          if (nc === 44) { pos++; ended = 0; }
          else if (nc === 10) { pos++; line++; ended = 1; }
          else if (nc === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; ended = 1; }
          else {
            let start2 = pos, added = 0; ended = 2;
            while (pos < len) {
              const c = text.charCodeAt(pos);
              if (c === 44) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } pos++; ended = 0; break; }
              if (c === 10) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } pos++; line++; ended = 1; break; }
              if (c === 13) {
                if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; } pos += 2; line++; ended = 1; break; }
                const n = pos - start2; if (n > 0) { val += text.slice(start2, pos); added += n; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow }); pos++; start2 = pos; continue;
              }
              pos++;
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

module.exports = { run };
