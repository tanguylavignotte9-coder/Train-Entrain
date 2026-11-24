import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const entries = { app: 'src/main.ts' };
if (existsSync(join(root, 'src/preview.ts')) && process.env.PREVIEW) entries.preview = 'src/preview.ts';
await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
  outdir: dist, bundle: true, format: 'iife', target: 'chrome120', sourcemap: true, minify: false, logLevel: 'info',
  loader: { '.json': 'json' },
});
cpSync(join(root, 'static'), dist, { recursive: true });
if (existsSync(join(root, 'assets'))) cpSync(join(root, 'assets'), join(dist, 'assets'), { recursive: true });
console.log('Build terminé → dist/');
