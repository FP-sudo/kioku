import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installHooks,
  uninstallHooks,
  installedHookCommands,
  cliPathInCommand,
  targetFile,
} from '../src/hooks.mjs';

/**
 * HOME を使い捨てのフォルダに向けて実行する。
 * フックの注入先は実利用者の ~/.claude/settings.json なので、
 * テストが本物を触らないことをここで担保する。
 */
function withTempHome(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kioku-hooks-'));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KIOKU_HOME: process.env.KIOKU_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KIOKU_HOME = path.join(dir, '.kioku');
  try {
    return run(dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSettings(data) {
  const file = targetFile('claude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

test('フックは4本入り、2回目は増えない', () => {
  withTempHome(() => {
    assert.equal(installHooks('claude').added, 4);
    assert.equal(installHooks('claude').added, 0);
    assert.equal(installedHookCommands('claude').length, 4);
  });
});

test('利用者が元から入れていたフックを消さない', () => {
  withTempHome(() => {
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo 私のフック' }] }],
      },
    });
    installHooks('claude');
    const after = JSON.parse(fs.readFileSync(targetFile('claude'), 'utf8'));
    const commands = after.hooks.SessionStart.flatMap((e) => e.hooks).map((h) => h.command);
    assert.ok(commands.includes('echo 私のフック'), '利用者のフックが消えた');

    uninstallHooks('claude');
    const cleaned = JSON.parse(fs.readFileSync(targetFile('claude'), 'utf8'));
    const left = cleaned.hooks.SessionStart.flatMap((e) => e.hooks).map((h) => h.command);
    assert.deepEqual(left, ['echo 私のフック'], 'uninstall が他人のフックまで消した');
  });
});

test('指し先が消えた自分のフックだけを片付ける', () => {
  withTempHome(() => {
    // 旧版を別の場所に展開して使っていた人の設定を模す
    writeSettings({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: '"/usr/bin/node" "/nowhere/kioku.mjs" hook start --agent claude' },
              { type: 'command', command: 'echo 私のフック' },
            ],
          },
        ],
      },
    });

    const result = installHooks('claude');
    assert.equal(result.pruned, 1, '死んだ指し先が片付いていない');

    const commands = installedHookCommands('claude');
    assert.equal(commands.length, 4, '新しいフックが4本入っていない');
    assert.ok(!commands.some((c) => c.includes('/nowhere/')), '死んだ指し先が残っている');

    const after = JSON.parse(fs.readFileSync(targetFile('claude'), 'utf8'));
    const all = after.hooks.SessionStart.flatMap((e) => e.hooks).map((h) => h.command);
    assert.ok(all.includes('echo 私のフック'), '利用者のフックを巻き添えにした');
  });
});

test('実在する指し先は片付けない', () => {
  withTempHome(() => {
    installHooks('claude');
    const before = installedHookCommands('claude').length;
    assert.equal(installHooks('claude').pruned, 0);
    assert.equal(installedHookCommands('claude').length, before);
  });
});

test('コマンド文字列から CLI の場所を取り出す', () => {
  const quoted = '"/usr/bin/node" "/Users/me/.kioku/app/bin/kioku.mjs" hook start --agent claude';
  assert.equal(cliPathInCommand(quoted), '/Users/me/.kioku/app/bin/kioku.mjs');

  const bare = 'node /opt/kioku/bin/kioku.mjs hook end --agent codex';
  assert.equal(cliPathInCommand(bare), '/opt/kioku/bin/kioku.mjs');

  assert.equal(cliPathInCommand('echo 関係ないフック'), null);
});
