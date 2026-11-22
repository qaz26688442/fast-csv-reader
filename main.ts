const v8 = process.getBuiltinModule('node:v8');
v8.setFlagsFromString(
  '--no-incremental-marking --turbo-filter=csvParse --no-use-osr --no-turbo-inlining --no-turbo-escape --no-turbo-allocation-folding --invocation-count-for-feedback-allocation=1 --invocation-count-for-turbofan=8'
);

const { runCasesFiles, primeCsv } = require('./engine.cjs');
primeCsv(120);

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
runCasesFiles(`${INPUT_DIR}/cases.json`, `${OUTPUT_DIR}/answers.json`);
