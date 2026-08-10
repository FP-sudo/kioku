import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sandbox;
let vaultDir;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kioku-compile-'));
  vaultDir = path.join(sandbox, 'vault');
  process.env.KIOKU_HOME = path.join(sandbox, 'kioku-home');
  for (const d of ['daily', 'entities', 'concepts', 'decisions']) {
    fs.mkdirSync(path.join(vaultDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(vaultDir, 'INDEX.md'), '# 地図\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'SCHEMA.md'), '# ルール\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.KIOKU_HOME;
});

// --- 安全弁 ---------------------------------------------------------------

test('daily を書き換えられたら元に戻す', async () => {
  const { snapshotVault, verifyAndRestore } = await import('../src/guard.mjs');
  const note = path.join(vaultDir, 'daily', '2026-08-09.md');
  fs.writeFileSync(note, '元の記録\n', 'utf8');

  const snap = snapshotVault(vaultDir);
  fs.writeFileSync(note, '編纂が勝手に書き換えた\n', 'utf8'); // 事故を再現

  const { restored } = verifyAndRestore(snap);
  assert.ok(restored.some((r) => r.includes('2026-08-09.md')), restored.join(','));
  assert.equal(fs.readFileSync(note, 'utf8'), '元の記録\n');
});

test('daily が消されたら復元する', async () => {
  const { snapshotVault, verifyAndRestore } = await import('../src/guard.mjs');
  const note = path.join(vaultDir, 'daily', '2026-08-09.md');
  fs.writeFileSync(note, '消されては困る記録\n', 'utf8');

  const snap = snapshotVault(vaultDir);
  fs.unlinkSync(note);

  verifyAndRestore(snap);
  assert.equal(fs.readFileSync(note, 'utf8'), '消されては困る記録\n');
});

test('daily に生えた新規ファイルは取り消す', async () => {
  const { snapshotVault, verifyAndRestore } = await import('../src/guard.mjs');
  fs.writeFileSync(path.join(vaultDir, 'daily', '2026-08-09.md'), 'x\n', 'utf8');

  const snap = snapshotVault(vaultDir);
  const intruder = path.join(vaultDir, 'daily', 'summary.md');
  fs.writeFileSync(intruder, '編纂が作ったまとめ\n', 'utf8');

  verifyAndRestore(snap);
  assert.equal(fs.existsSync(intruder), false);
});

test('知識層への書き込みは許す', async () => {
  const { snapshotVault, verifyAndRestore } = await import('../src/guard.mjs');
  fs.writeFileSync(path.join(vaultDir, 'daily', '2026-08-09.md'), 'x\n', 'utf8');

  const snap = snapshotVault(vaultDir);
  fs.writeFileSync(path.join(vaultDir, 'entities', 'client-a.md'), '# A社\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'INDEX.md'), '# 地図\n更新\n', 'utf8');

  const { restored, unexpected } = verifyAndRestore(snap);
  assert.deepEqual(restored, []);
  assert.deepEqual(unexpected, []);
  assert.ok(fs.existsSync(path.join(vaultDir, 'entities', 'client-a.md')));
});

test('利用者の他のノートが変わったら、戻さずに報告する', async () => {
  const { snapshotVault, verifyAndRestore } = await import('../src/guard.mjs');
  const mine = path.join(vaultDir, '読書メモ.md');
  fs.writeFileSync(mine, '元の内容\n', 'utf8');

  const snap = snapshotVault(vaultDir);
  fs.writeFileSync(mine, '書き換えられた\n', 'utf8');

  const { restored, unexpected } = verifyAndRestore(snap);
  assert.deepEqual(restored, []);
  assert.deepEqual(unexpected, ['読書メモ.md']);
  assert.equal(fs.readFileSync(mine, 'utf8'), '書き換えられた\n', '勝手に巻き戻してはいけない');
});

test('.obsidian と .git は走査しない', async () => {
  const { listVaultFiles } = await import('../src/guard.mjs');
  fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '.obsidian', 'app.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(vaultDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '.git', 'HEAD'), 'ref: x', 'utf8');

  const files = listVaultFiles(vaultDir);
  assert.ok(!files.some((f) => f.startsWith('.obsidian')), files.join(','));
  assert.ok(!files.some((f) => f.startsWith('.git')), files.join(','));
});

// --- 対象日の決定 ---------------------------------------------------------

function writeState(state) {
  const dir = process.env.KIOKU_HOME;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
}

const baseConfig = () => ({ vaultDir, catchup: { maxDays: 3 } });

function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('前回の翌日から昨日までを対象にする', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  writeState({ lastCompiledDate: ymd(-3) });
  const targets = decideTargets(baseConfig(), {});
  assert.deepEqual(targets, [ymd(-2), ymd(-1)]);
});

test('今日は対象にしない', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  writeState({ lastCompiledDate: ymd(-1) });
  assert.deepEqual(decideTargets(baseConfig(), {}), []);
});

test('maxDays を超えて遡らない', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  writeState({ lastCompiledDate: ymd(-30) });
  const targets = decideTargets(baseConfig(), {});
  assert.equal(targets.length, 3);
  assert.equal(targets[0], ymd(-29));
});

test('状態が未来日でも自己増殖しない', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  writeState({ lastCompiledDate: ymd(+10) });
  const targets = decideTargets(baseConfig(), {});
  assert.deepEqual(targets, [], `未来日を編纂しようとしている: ${targets.join(',')}`);

  const state = JSON.parse(fs.readFileSync(path.join(process.env.KIOKU_HOME, 'state.json'), 'utf8'));
  assert.ok(state.lastCompiledDate <= ymd(0), state.lastCompiledDate);
});

test('--date 指定はその日だけを対象にする', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  writeState({ lastCompiledDate: ymd(-1) });
  assert.deepEqual(decideTargets(baseConfig(), { date: '2026-01-15' }), ['2026-01-15']);
  assert.deepEqual(decideTargets(baseConfig(), { date: 'きのう' }), []);
});

test('初回は記録のある日から始める', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  fs.writeFileSync(path.join(vaultDir, 'daily', `${ymd(-2)}.md`), 'x\n', 'utf8');
  fs.writeFileSync(path.join(vaultDir, 'daily', `${ymd(-1)}.md`), 'x\n', 'utf8');
  const targets = decideTargets(baseConfig(), {});
  assert.deepEqual(targets, [ymd(-2), ymd(-1)]);
});

test('記録が1つも無ければ何もしない', async () => {
  const { decideTargets } = await import('../src/compile.mjs');
  assert.deepEqual(decideTargets(baseConfig(), {}), []);
});
