import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/kioku.mjs', import.meta.url));

let sandbox;
let kiokuHome;
let vaultDir;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kioku-test-'));
  kiokuHome = path.join(sandbox, 'kioku-home');
  vaultDir = path.join(sandbox, 'vault');
  fs.mkdirSync(kiokuHome, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'daily'), { recursive: true });
  fs.writeFileSync(
    path.join(kiokuHome, 'config.json'),
    JSON.stringify({ version: 1, vaultDir }),
    'utf8'
  );
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** フックを実際の子プロセスとして走らせる。stdin に JSON を流し込む。 */
function hook(phase, payload, { agent = 'claude' } = {}) {
  return execFileSync('node', [CLI, 'hook', phase, '--agent', agent], {
    input: JSON.stringify(payload),
    env: { ...process.env, KIOKU_HOME: kiokuHome },
    encoding: 'utf8',
  });
}

function todayNote() {
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
  const file = path.join(vaultDir, 'daily', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

test('依頼文とファイルを溜めて、セッション終了時に daily へ1ブロックで書く', () => {
  hook('prompt', { session_id: 's1', cwd: '/tmp/work', prompt: 'LP の見出しを3案つくって' });
  hook('prompt', { session_id: 's1', prompt: '2案目をベースに書き直して' });
  hook('file', { session_id: 's1', tool_input: { file_path: '/tmp/work/index.html' } });
  hook('end', { session_id: 's1' });

  const note = todayNote();
  assert.ok(note, 'daily ノートが作られていない');
  assert.ok(note.includes('## 作業ログ'), note);
  assert.ok(note.includes('### Claude Code'), note);
  assert.ok(note.includes('LP の見出しを3案つくって'), note);
  assert.ok(note.includes('2案目をベースに書き直して'), note);
  assert.ok(note.includes('index.html'), note);
});

test('セッション終了で spool を片付ける', () => {
  hook('prompt', { session_id: 's2', prompt: 'テスト' });
  const spool = path.join(kiokuHome, 'spool');
  assert.equal(fs.readdirSync(spool).length, 1);
  hook('end', { session_id: 's2' });
  assert.equal(fs.readdirSync(spool).length, 0);
});

test('依頼文に混じった秘密は daily に残らない', () => {
  hook('prompt', {
    session_id: 's3',
    prompt: 'ANTHROPIC_API_KEY=sk-ant-verysecretvalue123456 を .env に入れて',
  });
  hook('end', { session_id: 's3' });

  const note = todayNote();
  assert.ok(!note.includes('sk-ant-verysecretvalue123456'), note);
  assert.ok(note.includes('[REDACTED]'), note);
});

test('認証情報が置かれる場所のファイルは記録しない', () => {
  hook('prompt', { session_id: 's4', prompt: '設定を直して' });
  hook('file', { session_id: 's4', tool_input: { file_path: path.join(os.homedir(), '.ssh/config') } });
  hook('end', { session_id: 's4' });

  const note = todayNote();
  assert.ok(!note.includes('.ssh'), note);
});

test('人が書いた既存の見出しを壊さない', () => {
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
  const file = path.join(vaultDir, 'daily', name);
  fs.writeFileSync(file, '# 今日\n\n## メモ\n\n打ち合わせは15時から。\n', 'utf8');

  hook('prompt', { session_id: 's5', prompt: '資料をまとめて' });
  hook('end', { session_id: 's5' });

  const note = fs.readFileSync(file, 'utf8');
  assert.ok(note.includes('## メモ'), note);
  assert.ok(note.includes('打ち合わせは15時から。'), note);
  assert.ok(note.includes('## 作業ログ'), note);
});

test('作業ログが既にあれば、その中に追記して見出しを増やさない', () => {
  hook('prompt', { session_id: 's6', prompt: '1回目' });
  hook('end', { session_id: 's6' });
  hook('prompt', { session_id: 's7', prompt: '2回目' });
  hook('end', { session_id: 's7' });

  const note = todayNote();
  const headings = note.split('\n').filter((l) => l.trim() === '## 作業ログ');
  assert.equal(headings.length, 1, note);
  assert.ok(note.includes('1回目'), note);
  assert.ok(note.includes('2回目'), note);
});

test('Codex の記録は別ラベルで書かれる', () => {
  hook('prompt', { session_id: 's8', prompt: 'ビルドを直して' }, { agent: 'codex' });
  hook('end', { session_id: 's8' }, { agent: 'codex' });
  assert.ok(todayNote().includes('### Codex'), todayNote());
});

test('スラッシュコマンドの展開結果は依頼文として記録しない', () => {
  hook('prompt', { session_id: 's9', prompt: '<command-name>/compact</command-name>' });
  hook('end', { session_id: 's9' });
  assert.equal(todayNote(), null);
});

test('未インストールでも落ちない', () => {
  fs.rmSync(path.join(kiokuHome, 'config.json'));
  const out = hook('prompt', { session_id: 's10', prompt: 'なにか' });
  assert.equal(out, '');
});

test('壊れた入力でも落ちない', () => {
  const out = execFileSync('node', [CLI, 'hook', 'prompt', '--agent', 'claude'], {
    input: 'this is not json',
    env: { ...process.env, KIOKU_HOME: kiokuHome },
    encoding: 'utf8',
  });
  assert.equal(out, '');
});
