// record.mjs — エージェントのフックから呼ばれる記録係。
//
// 設計の芯は3つ。
//   1. 何があっても exit 0。記録が1回落ちることより、利用者の作業が
//      止まる方がはるかに損害が大きい。
//   2. 依頼文はセッション中は spool に溜め、終わるときにまとめて1ブロック書く。
//      ターンごとに daily へ追記すると、ノートが断片で埋まって読めなくなる。
//   3. セッション終了フックは来ないことがある（Codex 側の対応差、強制終了）。
//      次にエージェントが起動したとき、放置された spool を回収する。

import fs from 'node:fs';
import path from 'node:path';
import { spoolDir, ensureKiokuHome, kiokuHome } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { log } from './log.mjs';
import { compactText, sanitizePath } from './sanitize.mjs';
import { appendToWorklog, localDateString, localTimeString, withLock } from './daily.mjs';

/** これ以上更新のない spool は、終了フックが来なかったものとみなして回収する。 */
const ORPHAN_AFTER_MS = 6 * 60 * 60 * 1000;

const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export async function runHook({ args, flags }) {
  const phase = args[0];
  const agent = normalizeAgent(flags.agent);

  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    log(`hook ${phase}: 入力を読めませんでした (${err.message})`);
  }

  const config = safeLoadConfig();
  if (!config?.vaultDir) {
    // 未インストール。黙って抜ける（インストール前のフックが残っている場合など）
    return 0;
  }

  switch (phase) {
    case 'prompt':
      capturePrompt(config, agent, payload);
      break;
    case 'file':
      captureFile(config, agent, payload);
      break;
    case 'end':
      flushSession(config, agent, payload);
      break;
    case 'start':
      reclaimOrphans(config);
      await maybeCatchup();
      break;
    default:
      log(`hook: 知らない phase (${phase})`);
  }
  return 0;
}

function normalizeAgent(value) {
  if (typeof value !== 'string') return 'claude';
  const v = value.toLowerCase();
  return v in AGENT_LABELS ? v : 'claude';
}

function safeLoadConfig() {
  try {
    return loadConfig();
  } catch (err) {
    log(`設定を読めませんでした: ${err.message}`);
    return null;
  }
}

// --- spool ----------------------------------------------------------------

function spoolFile(agent, sessionId) {
  const safeId = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
  return path.join(spoolDir(), `${agent}-${safeId}.json`);
}

function readSpool(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSpool(file, data) {
  ensureKiokuHome();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function newSpool(agent, payload) {
  const now = new Date().toISOString();
  return {
    agent,
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    startedAt: now,
    updatedAt: now,
    requests: [],
    files: [],
  };
}

// --- 各フェーズ -----------------------------------------------------------

function capturePrompt(config, agent, payload) {
  if (!config.record?.requests) return;

  // Claude Code / Codex とも UserPromptSubmit の入力に prompt が入る。
  // 将来フィールド名が変わっても落ちないよう、候補を順に見る。
  const text = payload.prompt ?? payload.user_prompt ?? payload.message ?? '';
  if (typeof text !== 'string' || !text.trim()) return;

  // スラッシュコマンドの展開結果やフックの注入文は依頼ではない
  if (/^\s*<(?:command-name|command-message|local-command|system-reminder)/.test(text)) return;

  const file = spoolFile(agent, payload.session_id);
  const spool = readSpool(file) ?? newSpool(agent, payload);
  const max = config.record.maxRequestsPerSession ?? 40;

  if (spool.requests.length < max) {
    spool.requests.push(compactText(text, config.record.maxRequestChars ?? 300));
  } else if (spool.requests.length === max) {
    spool.requests.push('（以降は記録上限のため省略）');
  }
  spool.cwd ??= payload.cwd ?? null;
  spool.updatedAt = new Date().toISOString();
  writeSpool(file, spool);
}

function captureFile(config, agent, payload) {
  if (!config.record?.files) return;

  const raw =
    payload.tool_input?.file_path ??
    payload.tool_input?.path ??
    payload.tool_input?.notebook_path ??
    null;
  if (!raw) return;

  const cleaned = sanitizePath(raw, { relativize: config.record.relativizePaths !== false });
  if (!cleaned || cleaned === '[SENSITIVE PATH REDACTED]') return;

  const file = spoolFile(agent, payload.session_id);
  const spool = readSpool(file) ?? newSpool(agent, payload);
  if (!spool.files.includes(cleaned) && spool.files.length < 60) {
    spool.files.push(cleaned);
  }
  spool.updatedAt = new Date().toISOString();
  writeSpool(file, spool);
}

function flushSession(config, agent, payload) {
  const file = spoolFile(agent, payload.session_id);
  const spool = readSpool(file);
  if (!spool) return;
  writeBlock(config, spool);
  try {
    fs.unlinkSync(file);
  } catch {
    /* 既に消えている */
  }
}

/**
 * 前回の編纂から時間が経っていれば、切り離したプロセスで編纂を走らせる。
 * 常駐スケジューラを使わずに毎日の編纂を回すための入口。
 */
async function maybeCatchup() {
  try {
    const { runCatchup } = await import('./catchup.mjs');
    await runCatchup({ flags: {} });
  } catch (err) {
    log(`catchup を起動できませんでした: ${err.message}`);
  }
}

/** 終了フックが来なかった spool を拾って書き出す。 */
function reclaimOrphans(config) {
  let names;
  try {
    names = fs.readdirSync(spoolDir());
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(spoolDir(), name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < ORPHAN_AFTER_MS) continue;

    const spool = readSpool(file);
    if (spool) {
      log(`放置されていた記録を回収: ${name}`);
      writeBlock(config, spool);
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* 競合しても実害なし */
    }
  }
}

// --- 書き出し -------------------------------------------------------------

function writeBlock(config, spool) {
  if (!spool.requests?.length && !spool.files?.length) return;

  const started = new Date(spool.startedAt);
  const ended = new Date(spool.updatedAt);
  const dateStr = localDateString(started);
  const label = AGENT_LABELS[spool.agent] ?? spool.agent;

  const lines = [`### ${label}（${localTimeString(started)}〜${localTimeString(ended)}）`, ''];

  if (spool.cwd) {
    const where = sanitizePath(spool.cwd, { relativize: config.record.relativizePaths !== false });
    if (where && where !== '[SENSITIVE PATH REDACTED]') {
      lines.push(`作業場所: \`${where}\``, '');
    }
  }

  for (const req of spool.requests ?? []) {
    lines.push(`- ${req}`);
  }

  if (spool.files?.length) {
    lines.push('');
    const shown = spool.files.slice(0, 12).map((f) => `\`${f}\``).join('、');
    const rest = spool.files.length - 12;
    lines.push(`触ったファイル: ${shown}${rest > 0 ? ` ほか${rest}件` : ''}`);
  }

  try {
    withLock(path.join(kiokuHome(), 'daily.lock'), () => {
      appendToWorklog(config.vaultDir, dateStr, lines.join('\n'));
    });
  } catch (err) {
    log(`daily への書き出しに失敗: ${err.message}`);
  }
}

// --- stdin ----------------------------------------------------------------

/**
 * フックの入力を読む。
 * 呼び出し側がすぐ閉じない実装だとここで固まるので、必ず上限時間で切る。
 */
function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) finish(); // 想定外に大きい入力は打ち切る
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}
