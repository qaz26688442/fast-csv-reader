import './flags.js';
import { openSync, fstatSync, readSync, writeSync, closeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runCasesBuffer, primeCsv } from './solve.js';

primeCsv(setFlagsFromString);

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const fd = openSync(`${INPUT_DIR}/cases.json`, 'r');
const sz = fstatSync(fd).size;
const raw = Buffer.allocUnsafe(sz);
let off = 0;
while (off < sz) {
  const n = readSync(fd, raw, off, sz - off, off);
  if (n <= 0) break;
  off += n;
}
closeSync(fd);

const ofd = openSync(`${OUTPUT_DIR}/answers.json`, 'w');
runCasesBuffer(raw, (buf: Uint8Array, len: number) => {
  let woff = 0;
  while (woff < len) {
    woff += writeSync(ofd, buf, woff, len - woff);
  }
});
closeSync(ofd);
