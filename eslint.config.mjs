import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['main.js', 'node_modules/**', 'dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': ['error', { patterns: ['electron', 'node:fs', 'fs'] }],
      'no-restricted-properties': ['error', { property: 'innerHTML', message: 'Use DOM text nodes or Obsidian safe rendering.' }],
    },
  },
);
