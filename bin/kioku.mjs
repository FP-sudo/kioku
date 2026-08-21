#!/usr/bin/env node
// kioku — Claude Code / Codex の作業を Obsidian に自動記録し、知識へ編纂する。
//
// サブコマンドは動的 import で読む。フック（kioku hook ...）は
// セッションのたびに走るので、使わないモジュールを読み込まないことが効く。

import { warn, say } from '../src/log.mjs';

const usage = (cmd) => `kioku — 作業を Obsidian に自動記録し、知識へ編纂する

呼び方:
  ${cmd} <コマンド>
  以下は kioku と略記します。毎回打つのが面倒なら、README のエイリアス設定を見てください。

使い方:
  kioku init                 vault を決めてフックを設定する（最初に1回）
  kioku status               記録と編纂の状況を表示する
  kioku doctor               環境と設定を点検する
  kioku compile [options]    溜まった daily ノートを知識に編纂する
  kioku catchup              前回から時間が経っていれば編纂する（フック用）
  kioku uninstall            kioku が入れたフックを取り外す

compile のオプション:
  --date YYYY-MM-DD   その日だけを編纂する
  --days N            さかのぼる日数の上限（既定は設定の catchup.maxDays）
  --dry-run           何を編纂するかだけ表示して実行しない

その他:
  kioku hook <phase>  エージェントのフックから呼ばれる内部コマンド
  kioku --version     バージョンを表示する
`;

const COMMANDS = {
  init: () => import('../src/install.mjs').then((m) => m.runInit),
  uninstall: () => import('../src/install.mjs').then((m) => m.runUninstall),
  status: () => import('../src/status.mjs').then((m) => m.runStatus),
  doctor: () => import('../src/doctor.mjs').then((m) => m.runDoctor),
  compile: () => import('../src/compile.mjs').then((m) => m.runCompile),
  catchup: () => import('../src/catchup.mjs').then((m) => m.runCatchup),
  hook: () => import('../src/record.mjs').then((m) => m.runHook),
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (flags.version || command === 'version') {
    const { readFileSync } = await import('node:fs');
    const { packageRoot } = await import('../src/paths.mjs');
    const { join } = await import('node:path');
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8'));
    say(`kioku ${pkg.version}`);
    return 0;
  }

  if (!command || command === 'help' || flags.help) {
    const { invocation } = await import('../src/paths.mjs');
    say(usage(invocation()));
    return 0;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    const { invocation } = await import('../src/paths.mjs');
    warn(`知らないコマンドです: ${command}\n`);
    warn(usage(invocation()));
    return 1;
  }

  const run = await loader();
  return (await run({ args: positional.slice(1), flags })) ?? 0;
}

// フックから呼ばれたときは、失敗してもエージェントのセッションを止めない。
// 記録が1回抜けることより、利用者の作業が中断される方がはるかに損害が大きい。
const isHook = process.argv[2] === 'hook' || process.argv[2] === 'catchup';

main()
  .then((code) => {
    process.exit(isHook ? 0 : code);
  })
  .catch((err) => {
    if (isHook) {
      import('../src/log.mjs').then(({ log }) => {
        log(`FATAL(hook): ${err?.stack || err}`);
        process.exit(0);
      }).catch(() => process.exit(0));
    } else {
      warn(`エラー: ${err?.message || err}`);
      if (process.env.KIOKU_DEBUG) warn(String(err?.stack || ''));
      process.exit(1);
    }
  });
