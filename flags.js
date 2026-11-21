import { setFlagsFromString } from 'node:v8';

setFlagsFromString(
  '--no-incremental-marking --turbo-filter=csvParse --no-use-osr --no-turbo-inlining --no-turbo-escape --no-turbo-allocation-folding --no-turbo-loop-peeling --no-turbo-store-elimination --no-turbo-splitting --no-turbo-load-elimination --no-turbo-cf-optimization --no-turbo-jt --no-turbo-move-optimization --no-turbo-loop-variable --no-turbo-loop-rotation --no-turbo-instruction-scheduling --no-turbo-typer-hardening --turboshaft-instruction-selection --invocation-count-for-feedback-allocation=1'
);
