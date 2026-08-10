// log.mjs — フックの中で起きたことを追える最小のログ。
// フックは標準出力を汚すとエージェント側の表示を壊すので、記録は必ずファイルへ。

import fs from 'node:fs';
import path from 'node:path';
import { logPath, kiokuHome } from './paths.mjs';

const MAX_LOG_BYTES = 1024 * 1024; // 1MB を超えたら1世代だけ退避する

export function log(message) {
  try {
    fs.mkdirSync(kiokuHome(), { recursive: true });
    const file = logPath();
    rotateIfNeeded(file);
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(file, `[${stamp}] ${message}\n`, 'utf8');
  } catch {
    // ログが書けないこと自体でセッションを壊さない
  }
}

function rotateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  try {
    fs.renameSync(file, path.join(path.dirname(file), 'kioku.log.1'));
  } catch {
    // 退避に失敗したら追記を続ける。消すよりマシ。
  }
}

/** 利用者に見せるメッセージ。日本語。 */
export function say(message) {
  process.stdout.write(message + '\n');
}

export function warn(message) {
  process.stderr.write(message + '\n');
}
