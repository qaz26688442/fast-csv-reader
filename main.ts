import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking --turbo-filter=csvParse --no-use-osr --no-turbo-inlining --invocation-count-for-feedback-allocation=1 --invocation-count-for-turbofan=8');

const { runCasesBuffer, primeCsv } = await import('./solve.js');
primeCsv(120);

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const fd = openSync(`${INPUT_DIR}/cases.json`, 'r');
const sz = fstatSync(fd).size;
const raw = Buffer.allocUnsafe(sz);
let off = 0;
while (off < sz) { const n = readSync(fd, raw, off, sz - off, off); if (n <= 0) break; off += n; }
closeSync(fd);
const ofd = openSync(`${OUTPUT_DIR}/answers.json`, 'w');
runCasesBuffer(raw, ofd);
closeSync(ofd);
