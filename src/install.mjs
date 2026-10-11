// install.mjs — kioku init / uninstall。
//
// init が終わった時点で「記録が始まっている」状態にする。
// 追加の常駐設定や OS ごとのスケジューラ登録は要求しない。
// Windows でタスクスケジューラを触らせるのは、脱落と事故の温床なので避ける。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  detectObsidianVaults,
  defaultVaultDir,
  ensureKiokuHome,
  packageRoot,
  configPath,
  appDir,
  kiokuHome,
  tilde,
  invocation,
} from './paths.mjs';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from './config.mjs';
import { say, warn, log } from './log.mjs';
import { installHooks, uninstallHooks, isInstalled } from './hooks.mjs';
import { detectCompilers } from './agent.mjs';

export async function runInit({ flags = {} } = {}) {
  say('kioku をセットアップします。\n');

  const existing = loadConfig();
  const vaultDir = await chooseVault(flags, existing);
  if (!vaultDir) {
    warn('中止しました。');
    return 1;
  }

  const copied = seedVault(vaultDir);
  ensureKiokuHome();

  // フックを張る前に本体を据え置く。フックが指すのは、以降ここになる。
  let app;
  try {
    app = installApp();
  } catch (err) {
    warn(`× 本体の設置に失敗しました: ${err.message}`);
    warn('  展開したフォルダから直接動かす形で続けます。');
    warn('  この場合、フォルダを移動・削除すると記録が止まります。');
    app = { path: packageRoot(), copied: false };
  }

  const config = saveConfig({
    ...(existing ?? DEFAULT_CONFIG),
    vaultDir,
    compiler: normalizeCompilerFlag(flags.compiler) ?? existing?.compiler ?? 'auto',
  });

  say(`\n記録先: ${vaultDir}`);
  if (copied.length) say(`雛形を置きました（${copied.length}件）`);
  say(`設定: ${configPath()}`);
  if (app.copied) say(`本体: ${tilde(app.path)}`);

  // フックは、実際に入っているエージェントにだけ入れる
  const found = detectCompilers({ refresh: true });
  const results = [];
  for (const agent of ['claude', 'codex']) {
    const home = agent === 'claude' ? '.claude' : '.codex';
    const hasAgentHome = fs.existsSync(path.join(process.env.HOME || process.env.USERPROFILE || '', home));
    if (!found[agent] && !hasAgentHome) continue;
    try {
      results.push({ agent, ...installHooks(agent) });
    } catch (err) {
      warn(`× ${agent} のフック設定に失敗しました: ${err.message}`);
    }
  }

  say('');
  if (!results.length) {
    warn('⚠ Claude Code も Codex も見つかりませんでした。');
    warn('  どちらかを入れてから `kioku init` をやり直してください。');
    return 1;
  }
  for (const r of results) {
    const label = r.agent === 'claude' ? 'Claude Code' : 'Codex';
    say(r.added > 0 ? `✓ ${label} に記録フックを設定しました` : `✓ ${label} は設定済みです`);
    if (r.pruned > 0) say(`  （指し先が消えていた古いフックを ${r.pruned} 件片付けました）`);
  }

  const compilerNote = found.claude
    ? 'claude'
    : found.codex
      ? 'codex'
      : null;
  say('');
  if (compilerNote) {
    say(`編纂は ${compilerNote} で実行します（設定の compiler で変えられます）。`);
  } else {
    warn('⚠ 編纂を実行できるエージェントが見つかりません。記録だけが動きます。');
  }

  say('');
  say('次にエージェントを起動した時点から記録が始まります。');
  say('');
  const cmd = invocation();
  say('様子を見たくなったら、次のように打ってください。');
  say(`  ${cmd} status    記録と編纂の状況を見る`);
  say(`  ${cmd} doctor    動かないときの原因切り分け`);
  say(`  ${cmd} compile   溜まった記録を今すぐ編纂する`);
  if (app.copied) {
    say('');
    say('本体は上の場所に控えました。展開したフォルダはもう消してかまいません。');
  }
  return 0;
}

export async function runUninstall({ flags = {} } = {}) {
  let total = 0;
  for (const agent of ['claude', 'codex']) {
    try {
      const { file, removed } = uninstallHooks(agent);
      if (removed > 0) {
        say(`✓ ${file} から ${removed} 件のフックを外しました`);
        total += removed;
      }
    } catch (err) {
      warn(`× ${agent}: ${err.message}`);
    }
  }
  if (total === 0) say('外すフックはありませんでした。');

  say('');
  say('記録と設定はそのまま残しています。');
  say(`  記録: ${loadConfig()?.vaultDir ?? '(未設定)'}`);
  say(`  設定と本体: ${tilde(kiokuHome())}`);
  if (!flags.yes) say('完全に消す場合は、この2つを手で削除してください。');
  return 0;
}

// --- vault の決定 ---------------------------------------------------------

async function chooseVault(flags, existing) {
  if (typeof flags.vault === 'string') return path.resolve(flags.vault);

  const candidates = [];
  for (const v of detectObsidianVaults()) {
    candidates.push({ label: `${v.path}（Obsidian で最近開いた）`, value: v.path });
  }
  if (existing?.vaultDir && !candidates.some((c) => c.value === existing.vaultDir)) {
    candidates.unshift({ label: `${existing.vaultDir}（現在の設定）`, value: existing.vaultDir });
  }
  const fallback = defaultVaultDir();
  candidates.push({ label: `新しく作る: ${fallback}`, value: fallback });

  // 非対話（--yes、パイプ実行、CI）では黙って先頭を採る
  if (flags.yes || !stdin.isTTY) return candidates[0].value;

  say('記録先の vault を選んでください。\n');
  candidates.forEach((c, i) => say(`  ${i + 1}) ${c.label}`));
  say('');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`番号を入力（既定: 1、q で中止）: `)).trim();
    if (answer.toLowerCase() === 'q') return null;
    if (!answer) return candidates[0].value;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return candidates[n - 1].value;
    // 番号でなければパスとして受け取る
    return path.resolve(answer.replace(/^~(?=\/|\\|$)/, process.env.HOME || process.env.USERPROFILE || '~'));
  } finally {
    rl.close();
  }
}

/**
 * 雛形を置く。既にあるファイルには一切触らない。
 * 途中から使い始めた人の vault を、初期化で壊さないため。
 */
function seedVault(vaultDir) {
  const src = path.join(packageRoot(), 'templates', 'vault');
  const copied = [];
  if (!fs.existsSync(src)) {
    log(`雛形が見つかりません: ${src}`);
    fs.mkdirSync(path.join(vaultDir, 'daily'), { recursive: true });
    return copied;
  }

  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const to = path.join(vaultDir, relPath);
      if (e.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, relPath);
      } else if (!fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        copied.push(relPath);
      }
    }
  };
  fs.mkdirSync(vaultDir, { recursive: true });
  walk(src, '');
  // .gitkeep で作った空フォルダの目印は残さない
  for (const rel of [...copied]) {
    if (path.basename(rel) === '.gitkeep') {
      try {
        fs.unlinkSync(path.join(vaultDir, rel));
        copied.splice(copied.indexOf(rel), 1);
      } catch {
        /* 残っても実害はない */
      }
    }
  }
  return copied;
}

// --- 本体の設置 -----------------------------------------------------------

/** app に置くもの。テストと .git は要らない。 */
const APP_CONTENTS = ['bin', 'src', 'templates', 'package.json', 'README.md', 'LICENSE'];

/**
 * kioku 本体を ~/.kioku/app へ複製する。
 *
 * 差し替えは staging に組んでから rename で入れ替える。コピーの途中で失敗しても、
 * 既に動いている app を半端な状態にしない。フックは毎セッション走るので、
 * ここが壊れると利用者は毎回エラーを見ることになる。
 */
function installApp() {
  const from = packageRoot();
  const to = appDir();
  if (path.resolve(from) === path.resolve(to)) return { path: to, copied: false };

  const staging = `${to}.new-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const name of APP_CONTENTS) {
    const src = path.join(from, name);
    if (fs.existsSync(src)) copyTree(src, path.join(staging, name));
  }
  // コピー元を読み違えると空の app ができ、フックが展開フォルダを指したままになる。入れ替える前に止める
  if (!fs.existsSync(path.join(staging, 'bin', 'kioku.mjs'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`本体を ${from} から控えられませんでした。展開したフォルダで実行しているか確かめてください。`);
  }

  const previous = `${to}.old-${process.pid}`;
  if (fs.existsSync(to)) fs.renameSync(to, previous);
  try {
    fs.renameSync(staging, to);
  } catch (err) {
    if (fs.existsSync(previous)) fs.renameSync(previous, to);
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(previous, { recursive: true, force: true });
  log(`本体を設置: ${from} → ${to}`);
  return { path: to, copied: true };
}

function copyTree(from, to) {
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copyTree(path.join(from, name), path.join(to, name));
    }
  } else {
    fs.copyFileSync(from, to);
  }
}

function normalizeCompilerFlag(v) {
  return typeof v === 'string' && ['auto', 'claude', 'codex'].includes(v) ? v : null;
}

export { isInstalled };
