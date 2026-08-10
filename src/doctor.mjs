// doctor.mjs — 動かないときに、どこで止まっているかを言い当てる。
//
// 「動きません」という問い合わせに、往復せずに答えられることを目標にしている。
// 各項目は「何が問題か」だけでなく「次に何をすればいいか」まで出す。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.mjs';
import { configPath, kiokuHome, spoolDir, logPath } from './paths.mjs';
import { say, warn } from './log.mjs';
import { detectCompilers } from './agent.mjs';
import { isInstalled, targetFile } from './hooks.mjs';
import { loadState } from './config.mjs';

export async function runDoctor() {
  const results = [];
  const add = (ok, label, detail) => results.push({ ok, label, detail });

  // --- 実行環境 ---
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, `Node.js ${process.versions.node}`, major >= 18 ? null : 'Node 18 以上が必要です');
  add(true, `プラットフォーム: ${process.platform} / ${process.arch}`, null);

  // --- 設定 ---
  let config = null;
  try {
    config = loadConfig();
  } catch (err) {
    add(false, '設定ファイル', err.message);
  }

  if (!config) {
    add(false, '設定ファイル', `まだありません。\`kioku init\` を実行してください（${configPath()}）`);
  } else {
    const problems = validateConfig(config);
    add(problems.length === 0, `設定ファイル（${configPath()}）`, problems.join(' / ') || null);
  }

  // --- vault ---
  if (config?.vaultDir) {
    const exists = fs.existsSync(config.vaultDir);
    add(exists, `vault: ${config.vaultDir}`, exists ? null : 'フォルダがありません');

    if (exists) {
      const writable = canWrite(config.vaultDir);
      add(writable, 'vault への書き込み', writable ? null : '書き込めません。権限を確認してください');

      const dailyDir = path.join(config.vaultDir, 'daily');
      const hasDaily = fs.existsSync(dailyDir);
      add(hasDaily, 'daily フォルダ', hasDaily ? null : '`kioku init` で作られます');

      const schema = fs.existsSync(path.join(config.vaultDir, 'SCHEMA.md'));
      add(schema, 'SCHEMA.md（編纂のルール）', schema ? null : '無いと編纂の品質が落ちます。`kioku init` で置けます');
    }
  }

  // --- エージェント ---
  const found = detectCompilers({ refresh: true });
  const anyAgent = Boolean(found.claude || found.codex);
  add(anyAgent, '編纂に使えるエージェント', anyAgent ? null : 'claude / codex のどちらも見つかりません');
  if (found.claude) add(true, `  claude: ${found.claude}`, null);
  if (found.codex) add(true, `  codex: ${found.codex}`, null);

  if (config?.compiler && config.compiler !== 'auto' && !found[config.compiler]) {
    add(false, `compiler = ${config.compiler}`, `指定されたエージェントが見つかりません。auto にするか、入れてください`);
  }

  // --- フック ---
  for (const agent of ['claude', 'codex']) {
    const label = agent === 'claude' ? 'Claude Code' : 'Codex';
    const file = targetFile(agent);
    if (!fs.existsSync(file) && !found[agent]) continue;
    let installed = false;
    try {
      installed = isInstalled(agent);
    } catch (err) {
      add(false, `${label} のフック`, err.message);
      continue;
    }
    add(installed, `${label} の記録フック（${file}）`, installed ? null : '`kioku init` で設定できます');
  }

  // --- 状態 ---
  const state = loadState();
  if (state.lastCompiledDate) {
    add(true, `最後に編纂した日: ${state.lastCompiledDate}`, null);
  }
  const stuck = countSpools();
  if (stuck > 3) {
    add(false, `未書き出しのセッション記録: ${stuck}件`, '終了フックが動いていない可能性があります');
  }

  // --- 出力 ---
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      say(`✓ ${r.label}`);
      if (r.detail) say(`   ${r.detail}`);
    } else {
      failed++;
      warn(`× ${r.label}`);
      if (r.detail) warn(`   → ${r.detail}`);
    }
  }

  say('');
  say(`作業場所: ${kiokuHome()}`);
  say(`ログ: ${logPath()}`);
  say('');
  say(failed === 0 ? '問題は見つかりませんでした。' : `${failed}件の問題があります。`);
  return failed === 0 ? 0 : 1;
}

function canWrite(dir) {
  const probe = path.join(dir, `.kioku-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function countSpools() {
  try {
    return fs.readdirSync(spoolDir()).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
