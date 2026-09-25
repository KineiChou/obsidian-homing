import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const production = process.argv.includes('production');
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules],
  format: 'cjs',
  target: 'es2021',
  platform: 'browser',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  minify: production,
  outfile: 'main.js',
  // Keep the attribution in the distributed bundle (Apache-2.0 §4).
  banner: { js: '/*! Homing (归位) | Copyright 2026 KineiChou | Apache-2.0 | See LICENSE and NOTICE */' },
});
if (production) { await context.rebuild(); await context.dispose(); }
else await context.watch();
