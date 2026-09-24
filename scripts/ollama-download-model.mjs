// Optional acceptance setup: fetch pinned public models without creating Ollama user keys.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const directory = resolve(process.argv[2] ?? '/private/tmp/organizer-ollama-acceptance/models');
if (!directory.startsWith('/private/tmp/')) throw new Error('Use a dedicated /private/tmp model directory.');
const model = process.argv[3] ?? 'qwen3:0.6b';
const pins = { 'qwen3:0.6b': '7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435', 'qwen3:1.7b': '8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7' };
const expectedManifest = pins[model];
if (!expectedManifest) throw new Error('Choose one of the pinned acceptance models.');
const tag = model.split(':')[1];
const registry = 'https://registry.ollama.ai/v2/library/qwen3';
const manifestResponse = await fetch(registry + '/manifests/' + tag, { signal: AbortSignal.timeout(30000) });
if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
if (createHash('sha256').update(manifestBytes).digest('hex') !== expectedManifest) throw new Error('The public model tag changed. Recheck the official model before updating this pinned digest.');
await mkdir(directory + '/blobs', { recursive: true });
for (const layer of [manifest.config, ...manifest.layers]) {
  if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest)) throw new Error('Invalid manifest digest.');
  const path = directory + '/blobs/' + layer.digest.replace(':', '-');
  let existing = false;
  try {
    if ((await stat(path)).size === layer.size) {
      const cachedHash = createHash('sha256');
      for await (const chunk of createReadStream(path)) cachedHash.update(chunk);
      existing = cachedHash.digest('hex') === layer.digest.slice(7);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) { console.log(JSON.stringify({ verified: layer.digest, sizeBytes: layer.size, cached: true })); continue; }
  const partial = path + '.download';
  const hash = createHash('sha256'); let bytes = 0;
  try {
    const response = await fetch(registry + '/blobs/' + layer.digest, { signal: AbortSignal.timeout(900000) });
    if (!response.ok || !response.body) throw new Error(`Blob HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); } }), createWriteStream(partial));
    if (hash.digest('hex') !== layer.digest.slice(7) || bytes !== layer.size) throw new Error('Model blob failed digest or size validation.');
    await rename(partial, path);
    console.log(JSON.stringify({ verified: layer.digest, sizeBytes: bytes }));
  } finally { await rm(partial, { force: true }); }
}
const manifestDirectory = directory + '/manifests/registry.ollama.ai/library/qwen3';
await mkdir(manifestDirectory, { recursive: true });
await writeFile(manifestDirectory + '/' + tag, manifestBytes);
console.log(JSON.stringify({ model, manifest: expectedManifest, directory }));
