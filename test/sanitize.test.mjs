import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { sanitizeText, compactText, sanitizePath } from '../src/sanitize.mjs';

/** 秘密が原文のまま残っていないことを確かめる。 */
function assertRedacted(input, secret) {
  const out = sanitizeText(input);
  assert.ok(!out.includes(secret), `伏せられていない: ${out}`);
  return out;
}

test('形で分かるトークンを伏せる', () => {
  assertRedacted('key: sk-abcdefghijklmnopqrstuvwxyz123456', 'sk-abcdefghijklmnopqrstuvwxyz123456');
  assertRedacted('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
  assertRedacted('slack xoxb-1234567890-abcdefghijk', 'xoxb-1234567890-abcdefghijk');
  assertRedacted('aws AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE');
});

test('JWT を伏せる', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assertRedacted(`Authorization: Bearer ${jwt}`, jwt);
});

test('代入形式の秘密を伏せる', () => {
  const out = sanitizeText('ANTHROPIC_API_KEY=abcd1234efgh5678');
  assert.ok(!out.includes('abcd1234efgh5678'), out);
  assert.ok(out.includes('[REDACTED]'), out);

  const json = sanitizeText('{"client_secret": "s3cr3t-value-here"}');
  assert.ok(!json.includes('s3cr3t-value-here'), json);

  const cli = sanitizeText('curl --api-key mysecretkey123 https://example.com');
  assert.ok(!cli.includes('mysecretkey123'), cli);
});

test('日本語の地の文に書かれた秘密を伏せる', () => {
  const out = sanitizeText('APIキーは sk-livekey-abcdefghijklmno です');
  assert.ok(!out.includes('sk-livekey-abcdefghijklmno'), out);
});

test('秘密鍵ブロックをまるごと伏せる', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = sanitizeText(pem);
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'), out);
  assert.ok(out.includes('[PRIVATE KEY REDACTED]'), out);
});

test('認可 URL は伏せ、普通の URL は残す', () => {
  const oauth = sanitizeText('https://example.com/oauth/callback?code=abc123&state=xyz');
  assert.ok(oauth.includes('[OAUTH URL REDACTED]'), oauth);

  const normal = sanitizeText('参考: https://docs.anthropic.com/ja/docs/claude-code');
  assert.ok(normal.includes('https://docs.anthropic.com/ja/docs/claude-code'), normal);
});

test('二重エンコードされた認可 URL も伏せる', () => {
  const out = sanitizeText('https://example.com/x?redirect=%2523%2561ccess_%2574oken%253Dabc');
  assert.ok(out.includes('[OAUTH URL REDACTED]'), out);
});

test('接続情報つき URI を伏せる', () => {
  const out = sanitizeText('postgres://admin:hunter2@db.example.com:5432/app');
  assert.ok(!out.includes('hunter2'), out);
});

test('メールアドレスと電話番号を伏せる', () => {
  const mail = sanitizeText('連絡先は taro@example.co.jp です');
  assert.ok(!mail.includes('taro@example.co.jp'), mail);

  const tel = sanitizeText('電話: 03-1234-5678');
  assert.ok(!tel.includes('1234-5678'), tel);
});

test('ホームディレクトリを ~ に畳む', () => {
  const home = os.homedir();
  const out = sanitizeText(`${home}/Projects/dev/kioku を編集した`);
  assert.ok(!out.includes(home), out);
  assert.ok(out.includes('~/Projects/dev/kioku'), out);
});

test('認証情報が置かれる場所のパスは丸ごと伏せる', () => {
  const home = os.homedir();
  const out = sanitizeText(`${home}/.ssh/id_rsa を読んだ`);
  assert.ok(out.includes('[SENSITIVE PATH REDACTED]'), out);
  assert.ok(!out.includes('id_rsa'), out);
});

test('制御文字を落とす', () => {
  const out = sanitizeText('前\x00後\x1b');
  assert.equal(out, '前後');
});

test('日本語の本文は壊さない', () => {
  const text = 'LP の見出しを3案つくって、いちばん反応が取れそうなものを選んでほしい。';
  assert.equal(sanitizeText(text), text);
});

test('compactText は1行に畳み、ウィキリンクを無害化する', () => {
  const out = compactText('# 見出し\n- [[既存ノート]] を参照\n\n  `code`');
  assert.ok(!out.includes('\n'), out);
  assert.ok(!out.includes('[['), out);
  assert.ok(out.includes('［［既存ノート］］'), out);
});

test('compactText は上限で切る', () => {
  const out = compactText('あ'.repeat(500), 100);
  assert.ok(out.length <= 100, `長さ ${out.length}`);
  assert.ok(out.endsWith('…'), out);
});

test('compactText は空入力でも記録可能な文字列を返す', () => {
  assert.equal(compactText('   \n\n  '), '記録できる内容なし');
});

test('sanitizePath はホーム基準に畳み、区切りを / に揃える', () => {
  const home = os.homedir();
  assert.equal(sanitizePath(`${home}/a/b.md`), '~/a/b.md');
  assert.equal(sanitizePath(`${home}/.aws/credentials`), '[SENSITIVE PATH REDACTED]');
  assert.equal(sanitizePath(''), null);
});
