import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8', ...opts });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dad-cli-test-'));
}

test('dad init scaffolds a working HTTP addon', () => {
  const base = tmpDir();
  const target = path.join(base, 'my-http-addon');
  const out = run(['init', target, '--id', 'org.test.my-http-addon', '--name', 'My HTTP Addon']);
  assert.match(out, /Created http addon/);

  for (const f of ['package.json', 'manifest.json', 'tsconfig.json', 'src/index.ts', 'src/server.ts', 'README.md']) {
    assert.ok(fs.existsSync(path.join(target, f)), `expected ${f} to exist`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.id, 'org.test.my-http-addon');
  assert.equal(manifest.type, 'http');
});

test('dad init scaffolds an HTTP addon by default', () => {
  const base = tmpDir();
  const target = path.join(base, 'no-type-addon');
  const out = run(['init', target, '--id', 'org.test.no-type-addon', '--name', 'No Type Addon']);
  assert.match(out, /Created http addon/);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.type, 'http');
});

test('dad init refuses a non-empty target directory', () => {
  const base = tmpDir();
  const target = path.join(base, 'occupied');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'existing.txt'), 'x');
  assert.throws(() => run(['init', target, '--id', 'org.test.x']));
});

test('scaffolded HTTP addon builds with tsc against the real SDK and dad dev serves it', async () => {
  const base = tmpDir();
  const target = path.join(base, 'e2e-http-addon');
  run(['init', target, '--id', 'org.test.e2e-http-addon', '--name', 'E2E HTTP Addon']);

  // Point the scaffolded addon at THIS built SDK + THIS repo's typescript /
  // @types/node install instead of npm (no network access in the test sandbox).
const nodeModulesDir = path.join(target, 'node_modules');
  const scopeDir = path.join(nodeModulesDir, '@delulu-addons');
  const typesDir = path.join(nodeModulesDir, '@types');
fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(typesDir, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(ROOT, path.join(scopeDir, 'dad-sdk'), linkType);
  fs.symlinkSync(path.join(ROOT, 'node_modules', '@types', 'node'), path.join(typesDir, 'node'), linkType);
  const tscScript = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

  execFileSync('node', [tscScript], { cwd: target, encoding: 'utf-8' });
  assert.ok(fs.existsSync(path.join(target, 'dist', 'index.js')));

  // dad dev should start a real server, respond to a real stream request, then we kill it.
  const { spawn } = await import('node:child_process');
  const proc = spawn('node', [CLI, 'dev', target, '--port', '7999'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d.toString()));

  await new Promise((resolve) => setTimeout(resolve, 800)); // let the server bind

  const res = await fetch('http://localhost:7999/streams/movie/10378');
  const body = await res.json();
  proc.kill();

  assert.equal(res.status, 200);
  assert.equal(body[0].title, 'Example 1080p Stream');
  assert.match(stdout, /Listening on http:\/\/localhost:7999/);
});

test('dad dev prints exactly ONE curl example per fixture for the /streams route, even with both direct_stream + torrent declared', async () => {
  // Regression test: direct_stream and torrent both resolve to '/streams'
  // (CAPABILITY_ROUTES). dad dev used to iterate manifest.capabilities
  // directly when printing example curl commands, so an addon declaring
  // BOTH capabilities got every /streams curl line printed twice.
  const base = tmpDir();
  const target = path.join(base, 'both-caps-addon');
  run(['init', target, '--id', 'org.test.both-caps', '--name', 'Both Caps']);

  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.capabilities = ['direct_stream', 'torrent'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const nodeModulesDir = path.join(target, 'node_modules');
  const scopeDir = path.join(nodeModulesDir, '@delulu-addons');
  const typesDir = path.join(nodeModulesDir, '@types');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(typesDir, { recursive: true });
  fs.symlinkSync(ROOT, path.join(scopeDir, 'dad-sdk'), 'dir');
  fs.symlinkSync(path.join(ROOT, 'node_modules', '@types', 'node'), path.join(typesDir, 'node'), 'dir');
  const tscScript = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync('node', [tscScript], { cwd: target, encoding: 'utf-8' });

  const { spawn } = await import('node:child_process');
  const proc = spawn('node', [CLI, 'dev', target, '--port', '7998'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d.toString()));
  await new Promise((resolve) => setTimeout(resolve, 800));
  proc.kill();

  const streamsLines = stdout.split('\n').filter((l) => l.includes('curl') && l.includes('/streams/'));
  // 6 fixtures in DAD_TEST_FIXTURES -> exactly 6 curl lines for /streams,
  // not 12 (which is what printing once per capability produced).
  assert.equal(streamsLines.length, 6, `expected 6 unique /streams curl lines, got ${streamsLines.length}:\n${streamsLines.join('\n')}`);
});

test('dad init with no target directory exits cleanly with ONE error, no secondary crash trace', () => {
  // Regression test: the early-return guard for a missing target directory
  // called process.exit(1) with no `return` after it. In a real terminal
  // process.exit() terminates immediately so this "worked", but the missing
  // `return` meant execution could still fall through past the guard (e.g.
  // under any harness that intercepts process.exit), continuing with
  // dirName === undefined and crashing with a confusing, unrelated
  // "paths[1] argument must be of type string" error on top of the clean one.
  const result = spawnSync('node', [CLI, 'init'], { encoding: 'utf-8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /give a target directory/);
  // The bug's symptom was a SECOND, unrelated error appended after the
  // clean one - assert there's exactly one error block, not two.
  assert.equal((result.stderr.match(/Error:/g) || []).length, 1, `expected exactly one 'Error:' in stderr, got:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /paths\[1\]|argument must be of type/, 'a secondary Node internal error leaked through');
});

test('dad validate with no manifest.json in the target dir exits cleanly, no secondary crash trace', () => {
  // Same class of bug as above, in runValidate (cli.ts): missing `return`
  // after process.exit(1) let execution fall through to
  // fs.readFileSync(manifestPath) on a file we just confirmed doesn't
  // exist, throwing an unrelated ENOENT on top of the clean error message.
  const base = tmpDir();
  const emptyDir = path.join(base, 'no-manifest-here');
  fs.mkdirSync(emptyDir, { recursive: true });

  const result = spawnSync('node', [CLI, 'validate', emptyDir], { encoding: 'utf-8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest\.json not found/);
  assert.doesNotMatch(result.stderr, /ENOENT/, 'a secondary Node fs error leaked through');
});


