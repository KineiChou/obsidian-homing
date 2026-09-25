// Obsidian's plugin review rules, applied to the shipped plugin source only (`npm run lint:obsidian`).
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'dist/**', 'node_modules/**', 'tests/**', 'benchmarks/**', 'scripts/**', '*.mjs', 'vitest.config.ts'] },
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.obsidian.config.mjs'] } } } },
]);
