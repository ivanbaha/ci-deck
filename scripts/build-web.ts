import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from '../src/server/build-web.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await buildWeb(projectRoot);
console.log('web bundle written to public/');
