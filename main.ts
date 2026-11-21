import { openSync, fstatSync, readSync, writeSync, closeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { runCasesBuffer } = await import(new URL('./solve.js', import.meta.url).href);

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

const answers = runCasesBuffer(raw);

const ofd = openSync(`${OUTPUT_DIR}/answers.json`, 'w');
let woff = 0;
const wlen = answers.length;
while (woff < wlen) {
  woff += writeSync(ofd, answers, woff, wlen - woff);
}
closeSync(ofd);
