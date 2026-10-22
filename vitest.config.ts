import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      { extends: true, test: { name: 'pure', environment: 'node', include: ['tests/unit/**/*.test.ts'], exclude: ['tests/unit/input/**', 'tests/unit/ui/**', 'tests/unit/render/dom/**'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['tests/unit/input/**/*.test.ts', 'tests/unit/ui/**/*.test.ts', 'tests/unit/render/dom/**/*.test.ts'] } },
    ],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/render/**', 'src/ui/**', 'src/input/**', 'src/audio/engine.ts', 'src/app/**', 'src/platform/**', 'src/main.ts'] },
  },
});
