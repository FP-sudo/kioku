// catchup.mjs — 「エージェントを起動したときに追いつく」方式。
//
// 常駐スケジューラ（launchd / タスクスケジューラ）を使わないための仕掛け。
// OS ごとに別物を登録させるのは、Windows 側の脱落と事故が大きい。
// エージェントを起動する＝作業を始める瞬間なので、そこで前日ぶんを片付ければ足りる。
//
// フックは数秒で返す必要があるため、編纂そのものは切り離したプロセスで走らせる。

import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, loadState, saveState } from './config.mjs';
import { packageRoot } from './paths.mjs';
import { log, say } from './log.mjs';
import { decideTargets } from './compile.mjs';

export async function runCatchup({ flags = {} } = {}) {
  const config = loadConfig();
  if (!config?.vaultDir) return 0;
  if (!config.catchup?.enabled && !flags.force) return 0;

  const state = loadState();
  if (!flags.force && state.lastCompileAt) {
    const elapsedMs = Date.now() - new Date(state.lastCompileAt).getTime();
    const needMs = (config.catchup.minIntervalHours ?? 20) * 3600_000;
    if (Number.isFinite(elapsedMs) && elapsedMs < needMs) return 0;
  }

  const targets = decideTargets(config, {});
  if (!targets.length) return 0;

  // 起動前に時刻を進めておく。複数のエージェントがほぼ同時に立ち上がっても、
  // 編纂プロセスが二重に走らない（編纂側のロックと合わせて二重の防御）。
  saveState({ ...state, lastCompileAt: new Date().toISOString() });

  const cli = path.join(packageRoot(), 'bin', 'kioku.mjs');
  log(`catchup: ${targets.length}日ぶんの編纂を起動します`);

  const child = spawn(process.execPath, [cli, 'compile'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  if (flags.verbose) say(`${targets.length}日ぶんの編纂を後ろで走らせています。`);
  return 0;
}
