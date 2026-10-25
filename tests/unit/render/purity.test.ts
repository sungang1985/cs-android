/** The Node-testable render modules (texture recipes, motion math, map geometry, radar, presets) import no three. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../../src/render', import.meta.url));
const PURE = ['textures/ctx.ts', 'textures/paint.ts', 'textures/index.ts', 'textures/sprites.ts', 'textures/icons.ts', 'viewmodelMath.ts', 'mapGeometry.ts', 'quality.ts', 'radar.ts'];

describe('render purity', () => {
  for (const f of PURE) it(`${f} imports no three`, () => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) {
      expect(imp, `${f} imports ${imp}`).not.toMatch(/^three/);
      if (imp.startsWith('.')) {
        const target = path.relative(dir, path.resolve(path.dirname(path.join(dir, f)), imp));
        expect(['models', 'effects', 'materials', 'mapMesh', 'renderer', 'viewmodel', 'cameraRig', 'dressing'].some((x) => target === x || target.startsWith(x + '/') || target.startsWith(x + '.')), `${f} → ${target}`).toBe(false);
      }
    }
  });
  it('three is imported only through the package entry (plus BufferGeometryUtils)', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
    for (const file of walk(dir)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/from\s+'(three[^']*)'/g)) expect(['three', 'three/examples/jsm/utils/BufferGeometryUtils.js'], file).toContain(m[1]);
    }
  });
});
