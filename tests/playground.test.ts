// The playground must build to small static files that work offline.

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'glyph-playground-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('playground bundle', () => {
  it('builds, stays small and loads nothing from the network', async () => {
    await build({
      entryPoints: [join(root, 'src/playground/main.ts')],
      outfile: join(out, 'app.js'),
      bundle: true,
      minify: true,
      platform: 'browser',
      format: 'iife',
      loader: { '.gly': 'text' },
      logLevel: 'silent',
    });
    const js = readFileSync(join(out, 'app.js'), 'utf8');
    const html = readFileSync(join(root, 'src/playground/index.html'), 'utf8');
    const css = readFileSync(join(root, 'src/playground/style.css'), 'utf8');
    const total = js.length + html.length + css.length;
    expect(total).toBeLessThan(200 * 1024);
    // Every asset is local: no CDN scripts, fonts or fetches.
    expect(html).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/https?:\/\/|@import/);
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    // The example programs are embedded.
    expect(js).toContain('Game of Life');
  });
});
