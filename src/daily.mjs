// daily.mjs — 日付ごとのノートを読み書きする。
//
// daily ノートは「人も書くし kioku も書く」共有地。
// だから kioku は自分の見出しの中だけを触り、人が書いた行には一切手を出さない。

import fs from 'node:fs';
import path from 'node:path';

export const WORKLOG_SECTION = '## 作業ログ';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** ローカル時刻での YYYY-MM-DD。UTC に寄せると日付が1日ずれる。 */
export function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localTimeString(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** YYYY-MM-DD をローカル正午の Date にする。正午にするのは DST でずれないため。 */
export function parseDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(dateStr, delta) {
  const d = parseDateString(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() + delta);
  return localDateString(d);
}

export function dailyDir(vaultDir) {
  return path.join(vaultDir, 'daily');
}

export function dailyPath(vaultDir, dateStr = localDateString()) {
  return path.join(dailyDir(vaultDir), `${dateStr}.md`);
}

function newNoteBody(dateStr) {
  const d = parseDateString(dateStr) ?? new Date();
  const weekday = WEEKDAYS_JA[d.getDay()];
  return [
    '---',
    `date: ${dateStr}`,
    'type: daily',
    '---',
    '',
    `# ${dateStr}（${weekday}）`,
    '',
    '',
  ].join('\n');
}

/**
 * 作業ログの見出しの末尾に追記する。
 * 見出しが無ければファイル末尾に作る。既存の行は動かさない。
 */
export function appendToWorklog(vaultDir, dateStr, block) {
  const file = dailyPath(vaultDir, dateStr);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    content = newNoteBody(dateStr);
  }

  const normalized = block.trimEnd() + '\n';
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((l) => l.trim() === WORKLOG_SECTION);

  if (headingIndex === -1) {
    const sep = content.endsWith('\n') ? '' : '\n';
    content = `${content}${sep}\n${WORKLOG_SECTION}\n\n${normalized}`;
  } else {
    // 次の同レベル以上の見出しの直前までが作業ログの守備範囲
    let end = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i])) {
        end = i;
        break;
      }
    }
    while (end > headingIndex + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, '', ...normalized.trimEnd().split('\n'));
    content = lines.join('\n');
  }

  writeFileAtomic(file, content.endsWith('\n') ? content : content + '\n');
  return file;
}

export function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** daily/ にある日付ノートを古い順に返す。 */
export function listDailyDates(vaultDir) {
  let names;
  try {
    names = fs.readdirSync(dailyDir(vaultDir));
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort();
}

/**
 * 素朴なロックファイル。フックは同時に複数走りうるので、
 * daily への追記や編纂が交錯しないようにする。
 * 解放用の関数を返す。非同期処理を挟む場合はこちらを直接使う。
 */
export function acquireLock(lockFile, { retries = 20, waitMs = 50, staleMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let i = 0; i < retries; i++) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch {
      if (isStaleLock(lockFile, staleMs)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* 他プロセスが先に消しただけ */
        }
      }
      sleepSync(waitMs);
      continue;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* 既に消えている */
      }
    };
  }
  throw new Error(`ロックを取得できませんでした: ${lockFile}`);
}

/** 同期処理をロックで囲む。 */
export function withLock(lockFile, fn, options = {}) {
  const release = acquireLock(lockFile, options);
  try {
    return fn();
  } finally {
    release();
  }
}

/** 非同期処理をロックで囲む。処理が終わるまでロックを持ち続ける。 */
export async function withLockAsync(lockFile, fn, options = {}) {
  const release = acquireLock(lockFile, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 落ちたプロセスが残したロックを掴んだまま止まらないようにする。 */
function isStaleLock(lockFile, maxAgeMs = 60_000) {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  // フック内なので同期で待つ。Atomics.wait は SharedArrayBuffer 上でのみ使える。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
