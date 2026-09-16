import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  { name: '@mastra/factory', directory: 'mastracode/factory', file: 'factory.tgz', required: ['dist/index.js', 'dist/index.d.ts'] },
  { name: 'mastra', directory: 'packages/cli', file: 'mastra.tgz', required: ['dist/index.js', 'dist/factory/index.html', 'dist/factory/routes-manifest.json'] },
];
function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function customVersion(version, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid package version or commit.');
  return `${version}${version.includes('-') ? '.' : '-'}factory.${commit.slice(0, 12)}`;
}
export function prepare(directory = root) {
  const stateFile = join(directory, '.factory-release-state.json');
  if (existsSync(stateFile)) throw new Error('A release build is already prepared. Restore it first.');
  if (git(directory, 'status', '--porcelain')) throw new Error('Release builds require a clean checkout.');
  const commit = git(directory, 'rev-parse', 'HEAD');
  const manifests = packages.map(pkg => {
    const path = join(directory, pkg.directory, 'package.json');
    const original = readFileSync(path, 'utf8');
    const data = JSON.parse(original);
    if (data.name !== pkg.name) throw new Error(`Unexpected package in ${pkg.directory}.`);
    return { ...pkg, original, baseVersion: data.version, version: customVersion(data.version, commit) };
  });
  // Preserve originals before changing either file, including interrupted builds.
  writeFileSync(stateFile, JSON.stringify({ commit, manifests }, null, 2), { flag: 'wx' });
  for (const pkg of manifests) {
    writeFileSync(join(directory, pkg.directory, 'package.json'), `${JSON.stringify({ ...JSON.parse(pkg.original), version: pkg.version }, null, 2)}\n`);
  }
  return { commit, versions: manifests.map(({ name, version }) => ({ name, version })) };
}
export function restore(directory = root) {
  const stateFile = join(directory, '.factory-release-state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const pkg of packages) {
    const saved = state.manifests.find(item => item.name === pkg.name);
    if (!saved) throw new Error('Incomplete release state.');
    const path = join(directory, pkg.directory, 'package.json');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    const expected = { ...JSON.parse(saved.original), version: saved.version };
    if (JSON.stringify(current) !== JSON.stringify(expected) && JSON.stringify(current) !== JSON.stringify(JSON.parse(saved.original))) throw new Error(`Package ${pkg.name} changed after preparation; refusing to overwrite it.`);
  }
  for (const pkg of packages) {
    writeFileSync(join(directory, pkg.directory, 'package.json'), state.manifests.find(item => item.name === pkg.name).original);
  }
  unlinkSync(stateFile);
}
export function describeArtifact(path, metadata) {
  return { ...metadata, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
export function pack(directory = root) {
  const state = JSON.parse(readFileSync(join(directory, '.factory-release-state.json'), 'utf8'));
  if (git(directory, 'rev-parse', 'HEAD') !== state.commit) throw new Error('The source commit changed after preparation.');
  const allowed = new Set(packages.map(pkg => `${pkg.directory}/package.json`));
  const changed = git(directory, 'diff', 'HEAD', '--name-only').split('\n').filter(Boolean);
  if (changed.some(path => !allowed.has(path))) throw new Error('Source files changed during the build. Commit generated changes and rebuild.');
  const output = join(directory, 'factory-artifacts', state.commit);
  if (existsSync(output)) throw new Error('Artifacts already exist for this commit; refusing to overwrite them.');
  for (const pkg of packages) {
    const saved = state.manifests.find(item => item.name === pkg.name);
    const current = JSON.parse(readFileSync(join(directory, pkg.directory, 'package.json'), 'utf8'));
    if (!saved || JSON.stringify(current) !== JSON.stringify({ ...JSON.parse(saved.original), version: saved.version })) throw new Error(`Package ${pkg.name} changed after preparation.`);
    for (const path of pkg.required) if (!existsSync(join(directory, pkg.directory, path))) throw new Error(`Build output missing: ${pkg.directory}/${path}`);
  }
  mkdirSync(output, { recursive: true });
  const artifacts = [];
  for (const pkg of packages) {
    const saved = state.manifests.find(item => item.name === pkg.name);
    const archive = join(output, pkg.file);
    execFileSync('pnpm', ['pack', '--out', archive], { cwd: join(directory, pkg.directory), stdio: 'inherit' });
    artifacts.push(describeArtifact(archive, { name: pkg.name, version: saved.version, baseVersion: saved.baseVersion, file: pkg.file }));
  }
  const manifest = { schemaVersion: 1, sourceCommit: state.commit, artifacts };
  writeFileSync(join(output, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const operation = { prepare, pack, restore }[process.argv[2]];
    if (!operation) throw new Error('Usage: node scripts/factory-release.mjs <prepare|pack|restore>');
    console.log(JSON.stringify(operation() ?? { restored: true }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
