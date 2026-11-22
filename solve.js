import { createRequire } from 'node:module';
export const { run } = createRequire(import.meta.url)('./fallback.cjs');
