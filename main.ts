import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { runCasesBuffer } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runCasesBuffer: (buf: Buffer) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(`${INPUT_DIR}/cases.json`);
const answers = runCasesBuffer(raw);
writeFileSync(`${OUTPUT_DIR}/answers.json`, answers);
