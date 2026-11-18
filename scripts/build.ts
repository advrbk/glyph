// Builds the CLI, a library bundle (used by the benchmarks) and the playground.
//
//   dist/glyph.js            the `glyph` command (Node, one file)
//   dist/glyph-lib.js        the library API in one file
//   playground/dist/         static playground: index.html, app.js, style.css

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const only = process.argv[2];

async function cli() {
  await build({
    entryPoints: [join(root, 'src/cli.ts')],
    outfile: join(root, 'dist/glyph.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
  });
  await build({
    entryPoints: [join(root, 'src/glyph.ts')],
    outfile: join(root, 'dist/glyph-lib.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
}

async function playground() {
  const out = join(root, 'playground/dist');
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(root, 'src/playground/main.ts')],
    outfile: join(out, 'app.js'),
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    loader: { '.gly': 'text' },
    logLevel: 'warning',
  });
  copyFileSync(join(root, 'src/playground/index.html'), join(out, 'index.html'));
  copyFileSync(join(root, 'src/playground/style.css'), join(out, 'style.css'));
  let total = 0;
  for (const f of readdirSync(out)) {
    const size = statSync(join(out, f)).size;
    total += size;
    console.log(`  playground/dist/${f.padEnd(12)} ${(size / 1024).toFixed(1)} KB`);
  }
  console.log(`  total                     ${(total / 1024).toFixed(1)} KB`);
}

if (!only || only === 'cli') await cli();
if (!only || only === 'playground') await playground();
console.log('build done');
