// compile.mjs — daily の記録を知識層へ編纂する。
//
// 1日ぶんを1回の実行で処理し、終わるたびに状態を進める。
// 途中で落ちても、次に走らせれば続きから再開できる。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState, saveState, validateConfig } from './config.mjs';
import { lockPath, ensureKiokuHome } from './paths.mjs';
import { log, say, warn } from './log.mjs';
import { localDateString, addDays, dailyPath, listDailyDates, withLockAsync } from './daily.mjs';
import { snapshotVault, verifyAndRestore, cleanupBackups } from './guard.mjs';
import { buildCompilePrompt } from './prompt.mjs';
import { resolveCompiler, runCompilerAgent, commitIfGitRepo } from './agent.mjs';

export async function runCompile({ flags = {} } = {}) {
  const config = loadConfig();
  const problems = validateConfig(config);
  if (problems.length) {
    for (const p of problems) warn(`× ${p}`);
    return 1;
  }

  const compiler = resolveCompiler(config);
  if (!compiler) {
    warn('× 編纂に使えるエージェントが見つかりません（claude / codex のどちらかが必要です）');
    warn('  `kioku doctor` で状況を確認してください。');
    return 1;
  }

  const targets = decideTargets(config, flags);
  if (!targets.length) {
    say('編纂する日はありません。');
    return 0;
  }

  if (flags['dry-run']) {
    say(`編纂の対象（${compiler.kind} で実行予定）:`);
    for (const d of targets) say(`  ${d}  ${fs.existsSync(dailyPath(config.vaultDir, d)) ? '' : '（記録なし・スキップ）'}`);
    return 0;
  }

  ensureKiokuHome();
  let exitCode = 0;
  try {
    // 編纂は数分かかる。その間ずっとロックを持つので stale 判定を長めに取る。
    await withLockAsync(
      lockPath(),
      async () => {
        for (const date of targets) {
          const code = await compileOneDay({ config, compiler, date });
          if (code !== 0) {
            exitCode = code;
            break; // 失敗した日で止める。飛ばすと穴が空いたまま状態だけ進む
          }
        }
      },
      { retries: 3, waitMs: 200, staleMs: 30 * 60 * 1000 }
    );
  } catch (err) {
    warn(`× ${err.message}`);
    return 1;
  }
  cleanupBackups();
  return exitCode;
}

/** どの日を編纂するか決める。 */
export function decideTargets(config, flags) {
  if (typeof flags.date === 'string') {
    return /^\d{4}-\d{2}-\d{2}$/.test(flags.date) ? [flags.date] : [];
  }

  const today = localDateString();
  const yesterday = addDays(today, -1);
  const state = loadState();
  const maxDays = Number(flags.days) > 0 ? Number(flags.days) : config.catchup.maxDays;

  let cursor = state.lastCompiledDate;

  // 状態が未来日を指していると、いつまでも追いつけず状態だけが先へ進む。
  // exbrain が実際に踏んだ壊れ方なので、見つけたら黙って戻す。
  if (cursor && cursor > today) {
    log(`状態が未来日でした（${cursor}）。前日に戻します。`);
    cursor = addDays(today, -1);
    saveState({ ...state, lastCompiledDate: cursor });
  }

  if (!cursor) {
    // 初回。記録がある最古の日から始める。無ければ昨日だけ見る。
    const dates = listDailyDates(config.vaultDir).filter((d) => d < today);
    if (!dates.length) return [];
    cursor = addDays(dates[dates.length - Math.min(dates.length, maxDays)], -1);
  }

  const targets = [];
  let d = addDays(cursor, 1);
  while (d && d <= yesterday && targets.length < maxDays) {
    targets.push(d);
    d = addDays(d, 1);
  }
  return targets;
}

async function compileOneDay({ config, compiler, date }) {
  const noteFile = dailyPath(config.vaultDir, date);
  if (!fs.existsSync(noteFile)) {
    log(`${date}: 記録なし、スキップ`);
    advanceState(date, '記録なし');
    return 0;
  }

  say(`${date} を編纂中…（${compiler.kind}）`);
  log(`${date}: 編纂開始 (${compiler.kind})`);

  const snapshot = snapshotVault(config.vaultDir);
  const prompt = buildCompilePrompt({
    vaultDir: config.vaultDir,
    date,
    month: date.slice(0, 7),
  });

  const result = await runCompilerAgent({
    compiler,
    prompt,
    vaultDir: config.vaultDir,
    config,
    timeoutMs: Math.max(1, config.compileTimeoutMinutes ?? 15) * 60_000,
  });

  // 「更新なし」で終わったときに理由を追えるよう、出力を控えておく
  log(`${date}: 出力 ---\n${(result.stdout || '(なし)').slice(0, 4000)}\n--- 標準エラー ---\n${(result.stderr || '(なし)').slice(0, 2000)}`);

  const { restored, unexpected } = verifyAndRestore(snapshot);

  if (restored.length) {
    warn(`⚠ 触ってはいけない場所への変更を戻しました（${restored.length}件）`);
    for (const r of restored.slice(0, 10)) warn(`   ${r}`);
    log(`${date}: 保護層を復元 ${restored.join(', ')}`);
  }
  if (unexpected.length) {
    warn(`⚠ 想定外のファイルが変わっています（戻していません）:`);
    for (const u of unexpected.slice(0, 10)) warn(`   ${u}`);
    log(`${date}: 想定外の変更 ${unexpected.join(', ')}`);
  }

  if (!result.ok) {
    const why = result.timedOut ? '時間切れ' : `終了コード ${result.code}`;
    warn(`× ${date} の編纂に失敗しました（${why}）`);
    const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-5).join('\n');
    if (tail) warn(tail);
    log(`${date}: 失敗 ${why}`);
    saveState({ ...loadState(), lastCompileAt: new Date().toISOString(), lastResult: `失敗（${date}: ${why}）` });
    return 1;
  }

  if (config.git?.autoCommit) {
    const committed = commitIfGitRepo(config.vaultDir, `kioku: ${date} の編纂`);
    if (committed) log(`${date}: コミット ${committed.length}件`);
  }

  const summary = summarize(result.stdout);
  say(`  ${summary}`);
  advanceState(date, summary);
  log(`${date}: 完了 — ${summary}`);
  return 0;
}

function advanceState(date, summary) {
  saveState({
    ...loadState(),
    lastCompiledDate: date,
    lastCompileAt: new Date().toISOString(),
    lastResult: `${date}: ${summary}`,
  });
}

/** エージェントの出力から、利用者に見せる1行を作る。 */
function summarize(stdout) {
  const lines = (stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '出力なし';

  const changed = lines.filter((l) => /\.md$/.test(l) && !l.includes(' '));
  if (changed.length) {
    const names = changed.slice(0, 4).map((c) => path.basename(c));
    return `${changed.length}件更新（${names.join('、')}${changed.length > 4 ? ' ほか' : ''}）`;
  }
  const last = lines[lines.length - 1];
  return last.length > 80 ? last.slice(0, 79) + '…' : last;
}
