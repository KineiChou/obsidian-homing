import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (manifest.version !== pkg.version || manifest.id !== 'homing') throw new Error('Package and manifest must identify the same release.');
const destination = new URL('dist/homing/', root);
await mkdir(destination, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE']) await copyFile(new URL(file, root), new URL(file, destination));
console.log('Installable folder: ' + fileURLToPath(destination));
