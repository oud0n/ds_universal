import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const root = new URL('../.build/telemetry/', import.meta.url);
const digest = '4ed9e954382e6364a611250d8e66e4721dfe8832d55e73f690eaea383cd1c4f2';
const cache = new URL(`${digest}.json`, root);
const names = [
  'clock-offset/clockOffsetEstimator',
  'driving-analysis/drivingAnalysis',
  'log-conversion/bon4Writer',
  'log-conversion/logConverter',
  'log-conversion/nmeaExporter',
].flatMap(name => [`${name}.js`, `${name}.d.ts`]).concat('types/telemetry.d.ts');

async function readArtifact() {
  const file = process.env.LAPLOUPE_TELEMETRY_ARTIFACT;
  if (file) return readFile(file);

  try {
    return await readFile(cache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const url = process.env.LAPLOUPE_TELEMETRY_URL;
  if (!url) {
    throw new Error('Set LAPLOUPE_TELEMETRY_ARTIFACT to the telemetry artifact file or LAPLOUPE_TELEMETRY_URL to its HTTPS URL.');
  }
  if (new URL(url).protocol !== 'https:') throw new Error('The telemetry artifact URL must use HTTPS.');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (new URL(response.url).protocol !== 'https:') throw new Error('The telemetry artifact download must use HTTPS.');
  if (!response.ok) throw new Error(`Telemetry artifact download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const artifact = await readArtifact();
if (createHash('sha256').update(artifact).digest('hex') !== digest) {
  throw new Error('Telemetry artifact SHA-256 mismatch.');
}

const { version, files } = JSON.parse(artifact);
if (version !== 1 || Object.keys(files).length !== names.length ||
    names.some(name => !Object.hasOwn(files, name) || typeof files[name] !== 'string')) {
  throw new Error('Unexpected telemetry artifact contents.');
}

for (const name of names) {
  const target = new URL(`v1/${name}`, root);
  await mkdir(new URL('.', target), { recursive: true });
  await writeIfChanged(target, Buffer.from(files[name]));
}
await writeIfChanged(cache, artifact);

async function writeIfChanged(target, contents) {
  const current = await readFile(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current?.equals(contents)) return;

  const temporary = new URL(`${target.href}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
