// status.mjs — 今どうなっているかを一目で見せる。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState } from './config.mjs';
import { spoolDir, invocation } from './paths.mjs';
import { say, warn } from './log.mjs';
import { listDailyDates, localDateString, addDays } from './daily.mjs';
import { resolveCompiler } from './agent.mjs';

export async function runStatus() {
  const config = loadConfig();
  if (!config?.vaultDir) {
    warn(`まだセットアップされていません。\`${invocation('init')}\` を実行してください。`);
    return 1;
  }

  const state = loadState();
  const dates = listDailyDates(config.vaultDir);
  const compiler = resolveCompiler(config);

  say(`vault: ${config.vaultDir}`);
  say('');

  say('■ 記録');
  if (!dates.length) {
    say('  まだありません（次にエージェントを使うと溜まり始めます）');
  } else {
    say(`  ${dates.length}日ぶん（${dates[0]} 〜 ${dates[dates.length - 1]}）`);
    const today = localDateString();
    if (dates.includes(today)) say('  今日の記録: あり');
  }

  const active = countSpools();
  if (active > 0) say(`  進行中のセッション: ${active}件`);

  say('');
  say('■ 編纂');
  if (!state.lastCompiledDate) {
    say('  まだ一度も走っていません');
  } else {
    say(`  最後に編纂した日: ${state.lastCompiledDate}`);
    if (state.lastResult) say(`  直近の結果: ${state.lastResult}`);
  }

  const pending = countPending(config, state, dates);
  if (pending.length) {
    say(`  未編纂: ${pending.length}日（${pending.slice(0, 5).join('、')}${pending.length > 5 ? ' ほか' : ''}）`);
    say(`  → \`${invocation('compile')}\` で今すぐ編纂できます`);
  } else {
    say('  未編纂の記録はありません');
  }

  say('');
  say('■ 実行環境');
  say(`  編纂に使う: ${compiler ? `${compiler.kind}（${compiler.bin}）` : '見つかりません'}`);
  say(`  追いつき方式: ${config.catchup?.enabled ? `有効（${config.catchup.minIntervalHours}時間ごと）` : '無効'}`);

  return 0;
}

function countSpools() {
  try {
    return fs.readdirSync(spoolDir()).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** 記録があるのに編纂されていない日を数える。 */
function countPending(config, state, dates) {
  const yesterday = addDays(localDateString(), -1);
  const from = state.lastCompiledDate;
  return dates.filter((d) => d <= yesterday && (!from || d > from));
}
