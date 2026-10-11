import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 日本語を含むフォルダに展開して init すると、本体を ~/.kioku/app に控え、フックもそこを指すこと。
// 以前は import.meta.url の pathname（%E6... のまま）を使っていたため、本体が空のまま展開フォルダを指していた。
test('日本語を含む場所から init しても、本体を控えてフックが app を指す', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kioku-init-'));
  try {
    const extracted = path.join(sandbox, 'ダウンロード', 'kioku');
    for (const name of ['bin', 'src', 'templates', 'package.json', 'README.md']) {
      fs.cpSync(path.join(ROOT, name), path.join(extracted, name), { recursive: true });
    }
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.KIOKU_HOME;
    execFileSync('node', [path.join(extracted, 'bin', 'kioku.mjs'), 'init', '--yes', '--vault', path.join(home, 'vault')], {
      env,
      encoding: 'utf8',
    });

    const app = path.join(home, '.kioku', 'app');
    assert.ok(fs.existsSync(path.join(app, 'bin', 'kioku.mjs')), '本体が控えられていない');
    const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    assert.ok(settings.includes(path.join(app, 'bin', 'kioku.mjs').replaceAll('\\', '/')), settings);
    assert.ok(!settings.includes('%E'), settings);
    assert.ok(!settings.includes('ダウンロード'), settings);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
