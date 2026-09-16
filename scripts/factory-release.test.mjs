import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { customVersion, describeArtifact, pack, prepare, restore } from './factory-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [directory, name, version] of [['mastracode/factory', '@mastra/factory', '0.15.0'], ['packages/cli', 'mastra', '1.30.0']]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version }));
  }
  writeFileSync(join(root, '.gitignore'), '.factory-release-state.json\nfactory-artifacts/\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('add', '.');
  git('-c', 'user.name=Factory Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { root, git };
}

test('stamps backend and CLI with the same commit and restores exact originals', t => {
  const { root, git } = fixture(t);
  const file = join(root, 'mastracode/factory/package.json');
  const original = readFileSync(file, 'utf8');
  const result = prepare(root);
  assert.equal(result.versions.length, 2);
  for (const pkg of result.versions) assert.ok(pkg.version.endsWith(`factory.${result.commit.slice(0, 12)}`));
  restore(root);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(git('status', '--porcelain'), '');
});

test('preserves existing prerelease identity', () => {
  assert.equal(customVersion('0.16.0-alpha.1', 'a'.repeat(40)), '0.16.0-alpha.1.factory.aaaaaaaaaaaa');
});

test('refuses dirty source and repeated preparation', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'unfinished'), 'work');
  assert.throws(() => prepare(root), /clean checkout/);
  rmSync(join(root, 'unfinished'));
  prepare(root);
  assert.throws(() => prepare(root), /already prepared/);
});

test('does not overwrite edits made after preparation', t => {
  const { root } = fixture(t);
  prepare(root);
  const file = join(root, 'mastracode/factory/package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.description = 'keep this edit';
  writeFileSync(file, JSON.stringify(pkg));
  assert.throws(() => restore(root), /refusing to overwrite/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).description, 'keep this edit');
});

test('requires built backend and UI before packaging', t => {
  const { root } = fixture(t);
  prepare(root);
  assert.throws(() => pack(root), /Build output missing/);
  restore(root);
});

test('hashes artifact bytes to detect changes', t => {
  const { root } = fixture(t);
  const file = join(root, 'candidate.tgz');
  writeFileSync(file, 'first artifact');
  const first = describeArtifact(file, { name: 'mastra' });
  writeFileSync(file, 'changed artifact');
  const second = describeArtifact(file, { name: 'mastra' });
  assert.equal(first.sha256.length, 64);
  assert.notEqual(first.sha256, second.sha256);
});
