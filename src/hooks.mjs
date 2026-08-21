// hooks.mjs — Claude Code と Codex のフック設定を読み書きする。
//
// 両者の設定は形がほぼ同じ（イベント名 → [{matcher, hooks:[{type, command}]}]）。
// 違うのはファイルの場所と、Claude Code 側は他の設定と同居していること。
//
// ここでの絶対条件は「利用者が既に入れているフックを壊さない」。
// 追記だけを行い、消すのは自分が入れたものだけにする。

import fs from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath, codexHooksPath, cliPath } from './paths.mjs';

/** 自分が入れたフックだと判別するための印。 */
export const MARKER = 'kioku.mjs';

/**
 * フックから呼ぶコマンド文字列を作る。
 *
 * node は process.execPath を使う。PATH に node が無い環境
 * （GUI から起動されたアプリの子プロセスなど）でも確実に動かすため。
 * パス区切りは Windows でも / に揃える。bash と cmd の両方で、
 * バックスラッシュのエスケープ事故を避けられる。
 */
export function hookCommand(phase, agent) {
  const cli = cliPath().replaceAll('\\', '/');
  const node = process.execPath.replaceAll('\\', '/');
  return `"${node}" "${cli}" hook ${phase} --agent ${agent}`;
}

/** エージェントごとの、入れるべきフックの一覧。 */
export function desiredHooks(agent) {
  return [
    { event: 'UserPromptSubmit', matcher: null, command: hookCommand('prompt', agent) },
    { event: 'PostToolUse', matcher: 'Edit|Write|NotebookEdit', command: hookCommand('file', agent) },
    { event: 'SessionEnd', matcher: null, command: hookCommand('end', agent) },
    { event: 'SessionStart', matcher: null, command: hookCommand('start', agent) },
  ];
}

export function targetFile(agent) {
  return agent === 'codex' ? codexHooksPath() : claudeSettingsPath();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} を読めません: ${err.message}`);
  }
}

function writeJsonWithBackup(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.kioku-backup`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** hooks の入れ物を取り出す。Codex は最上位に description 等があるので構造が1段違う。 */
function getHooksContainer(root, agent) {
  if (agent === 'codex') {
    root.hooks ??= {};
    return root.hooks;
  }
  root.hooks ??= {};
  return root.hooks;
}

/** 既に kioku のフックが入っているか。 */
export function isInstalled(agent) {
  const file = targetFile(agent);
  const root = readJson(file);
  if (!root) return false;
  const container = root.hooks;
  if (!container) return false;
  return JSON.stringify(container).includes(MARKER);
}

/** 注入済みの kioku フックのコマンド文字列を集める。 */
export function installedHookCommands(agent) {
  const root = readJson(targetFile(agent));
  const found = [];
  for (const list of Object.values(root?.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command === 'string' && h.command.includes(MARKER)) found.push(h.command);
      }
    }
  }
  return found;
}

/**
 * フックのコマンド文字列から、呼ばれる CLI の場所を取り出す。
 * 実在しないパスが刺さっていれば、記録は毎セッション黙って落ちている。
 */
export function cliPathInCommand(command) {
  const quoted = command.match(/"([^"]*kioku\.mjs)"/);
  if (quoted) return quoted[1];
  const bare = command.match(/(\S*kioku\.mjs)/);
  return bare ? bare[1] : null;
}

/**
 * フックを注入する。
 * 同じイベント・同じ matcher のエントリがあればその中に足し、無ければ作る。
 */
export function installHooks(agent) {
  // 指し先の消えた古いフックを先に片付ける。読み込みはその後でないと、
  // 掃除の結果を取りこぼしたまま上書きしてしまう。
  const { removed: pruned } = pruneStaleHooks(agent);
  const file = targetFile(agent);
  const root = readJson(file) ?? (agent === 'codex' ? { description: 'Codex hooks' } : {});
  const container = getHooksContainer(root, agent);

  let added = 0;
  for (const { event, matcher, command } of desiredHooks(agent)) {
    container[event] ??= [];
    const list = container[event];

    // 既に同じコマンドが入っているなら何もしない（再実行しても増えない）
    const already = list.some((entry) => (entry.hooks ?? []).some((h) => h.command === command));
    if (already) continue;

    let entry = list.find((e) => (e.matcher ?? null) === matcher);
    if (!entry) {
      entry = matcher ? { matcher, hooks: [] } : { hooks: [] };
      list.push(entry);
    }
    entry.hooks ??= [];
    entry.hooks.push({ type: 'command', command, timeout: 10 });
    added++;
  }

  if (added > 0) writeJsonWithBackup(file, root);
  return { file, added, pruned };
}

/** 自分が入れたフックだけを取り除く。 */
export function uninstallHooks(agent) {
  return removeHooksWhere(agent, (h) => typeof h.command === 'string' && h.command.includes(MARKER));
}

/**
 * 自分が入れたフックのうち、指し先が消えているものを取り除く。
 *
 * 旧版を別の場所に展開して使っていた人が新版で init し直すと、
 * 古い指し先のフックが残る。放っておくと毎セッション、死んだパスを
 * 呼びに行くフックがエラーを吐き続ける。
 */
export function pruneStaleHooks(agent) {
  return removeHooksWhere(agent, (h) => {
    if (typeof h.command !== 'string' || !h.command.includes(MARKER)) return false;
    const cli = cliPathInCommand(h.command);
    return Boolean(cli) && !fs.existsSync(cli);
  });
}

function removeHooksWhere(agent, shouldRemove) {
  const file = targetFile(agent);
  const root = readJson(file);
  if (!root?.hooks) return { file, removed: 0 };

  let removed = 0;
  for (const [event, list] of Object.entries(root.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !shouldRemove(h));
      removed += before - entry.hooks.length;
    }
    // 空になったエントリを畳む。利用者の他の設定は残す。
    root.hooks[event] = list.filter((e) => (e.hooks?.length ?? 0) > 0);
    if (root.hooks[event].length === 0) delete root.hooks[event];
  }

  if (removed > 0) writeJsonWithBackup(file, root);
  return { file, removed };
}
