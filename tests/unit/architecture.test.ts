/** Architecture guard (§11.1): pure folders import no three/DOM/WebAudio and respect the import direction. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src', import.meta.url));
const PURE = ['core', 'settings', 'sim', 'world', 'maps', 'nav', 'weapons', 'rules', 'ai', 'i18n'];
const ALLOWED: Record<string, string[]> = {
  core: ['core'], settings: ['settings'], sim: ['core', 'sim', 'world', 'nav', 'weapons', 'rules'], world: ['core', 'world', 'sim'], maps: ['world'], nav: ['core', 'nav', 'world', 'sim'],
  weapons: ['core', 'world', 'sim', 'weapons'], rules: ['core', 'world', 'sim', 'weapons', 'rules'], ai: ['core', 'world', 'nav', 'sim', 'weapons', 'rules', 'ai'], i18n: ['i18n'],
};
const BANNED_GLOBALS = /\b(document|window|navigator|requestAnimationFrame|localStorage|AudioContext|HTMLCanvasElement|performance\.now|Date\.now|Math\.random)\b/;

function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path.join(dir, e.name)] : [])); }

describe('architecture', () => {
  for (const folder of PURE) {
    it(`src/${folder} is pure and respects import direction`, () => {
      const dir = path.join(root, folder);
      if (!fs.existsSync(dir)) return;
      for (const file of walk(dir)) {
        const src = fs.readFileSync(file, 'utf8');
        const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
        for (const imp of imports) {
          expect(imp, `${path.relative(root, file)} imports ${imp}`).not.toMatch(/^three/);
          if (imp.startsWith('.')) {
            const target = path.relative(root, path.resolve(path.dirname(file), imp)).split(path.sep)[0];
            expect(ALLOWED[folder], `${path.relative(root, file)} imports from ${target}`).toContain(target);
          }
        }
        if (file.endsWith(path.join('core', 'loop.ts'))) continue; // the clock adapter: browser scheduler defaults are injectable
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');
        const m = BANNED_GLOBALS.exec(stripped);
        expect(m, `${path.relative(root, file)} uses banned global ${m?.[0]}`).toBeNull();
      }
    });
  }
});
