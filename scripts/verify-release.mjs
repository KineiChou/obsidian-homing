import { readFile } from 'node:fs/promises';

const readJson = async name => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
const [manifest, packageInfo, lock, versions] = await Promise.all([
  'manifest.json', 'package.json', 'package-lock.json', 'versions.json',
].map(readJson));
const tag = process.argv[2];
const fail = message => { throw new Error(`Release validation failed: ${message}`); };
if (!tag || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) fail('provide an exact numeric x.y.z tag without a v prefix');
if (manifest.version !== tag || packageInfo.version !== tag || lock.version !== tag || lock.packages?.['']?.version !== tag) {
  fail('tag, manifest, package and lockfile versions must match');
}
if (versions[tag] !== manifest.minAppVersion) fail('versions.json must map the tag to manifest.minAppVersion');
if (manifest.isDesktopOnly !== true) fail('this preview supports desktop only');
console.log(`Release metadata verified for ${tag}.`);
