// config.mjs — 設定と状態の読み書き。
// 設定は人が編集する前提のファイル（~/.kioku/config.json）。
// 状態は kioku が書き換える内部データ（~/.kioku/state.json）。混ぜない。

import fs from 'node:fs';
import path from 'node:path';
import { configPath, statePath, ensureKiokuHome, invocation } from './paths.mjs';

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,

  /** 記録先の vault。init で決める。 */
  vaultDir: null,

  /** 編纂を実行するエージェント。auto は入っている方を自動で選ぶ。 */
  compiler: 'auto', // 'auto' | 'claude' | 'codex'

  /** claude -p のときに使うモデル。毎晩動くので安い階層を既定にする。 */
  claudeModel: 'claude-haiku-4-5',

  /** codex exec のときに使うモデル。空なら Codex 側の既定に任せる。 */
  codexModel: '',

  /**
   * 1日ぶんの編纂に許す時間（分）。超えたら打ち切る。
   * 記録量が多い日や、推論の重いモデルを指定した場合は延ばす。
   */
  compileTimeoutMinutes: 15,

  record: {
    /** 依頼文を記録するか。false にすると日付と件数だけになる。 */
    requests: true,
    /** 触ったファイルのパスを記録するか。 */
    files: true,
    /** ホーム配下の絶対パスを ~/ に畳む。ユーザー名が vault に残らない。 */
    relativizePaths: true,
    /** 1件の依頼文を何字まで残すか。長文プロンプトで daily が埋まるのを防ぐ。 */
    maxRequestChars: 300,
    /** 1セッションで残す依頼文の最大件数。 */
    maxRequestsPerSession: 40,
  },

  catchup: {
    /** エージェント起動時に「溜まっていたら編纂する」方式を使うか。 */
    enabled: true,
    /** 前回編纂からこの時間が経っていたら走らせる。 */
    minIntervalHours: 20,
    /** 1回で編纂する日数の上限。長期離脱後に何十日ぶんも回さないための蓋。 */
    maxDays: 3,
  },

  git: {
    /** vault が git リポジトリのとき、編纂結果を自動コミットするか。 */
    autoCommit: false,
  },
};

/** 深いマージ。利用者が一部だけ書いた config でも既定値で埋める。 */
function merge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return null; // 未インストール。呼び出し側が init を促す。
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `設定ファイルが壊れています: ${configPath()}\n  ${err.message}\n  直すか、削除して ${invocation('init')} をやり直してください。`
    );
  }
  return merge(DEFAULT_CONFIG, parsed);
}

export function saveConfig(config) {
  ensureKiokuHome();
  const merged = merge(DEFAULT_CONFIG, config);
  writeJsonAtomic(configPath(), merged);
  return merged;
}

export const DEFAULT_STATE = {
  /** 編纂が完了した最後の日付（YYYY-MM-DD）。 */
  lastCompiledDate: null,
  /** 最後に編纂を試みた時刻（ISO文字列）。catchup の間隔判定に使う。 */
  lastCompileAt: null,
  /** 直近の編纂結果。status で見せる。 */
  lastResult: null,
};

export function loadState() {
  try {
    return merge(DEFAULT_STATE, JSON.parse(fs.readFileSync(statePath(), 'utf8')));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  ensureKiokuHome();
  writeJsonAtomic(statePath(), merge(DEFAULT_STATE, state));
}

/**
 * 書き込み中に落ちても元ファイルを壊さない。
 * フックは強制終了されうるので、途中書きの JSON を残さないことが重要。
 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 設定が使える状態か検証する。doctor と各コマンドの入口で呼ぶ。 */
export function validateConfig(config) {
  const problems = [];
  if (!config) {
    problems.push(`設定がありません。\`${invocation('init')}\` を実行してください。`);
    return problems;
  }
  if (!config.vaultDir) {
    problems.push(`vaultDir が未設定です。\`${invocation('init')}\` を実行してください。`);
  } else if (!fs.existsSync(config.vaultDir)) {
    problems.push(`vault が見つかりません: ${config.vaultDir}`);
  }
  if (!['auto', 'claude', 'codex'].includes(config.compiler)) {
    problems.push(`compiler の値が不正です: ${config.compiler}（auto / claude / codex）`);
  }
  const h = config.catchup?.minIntervalHours;
  if (typeof h !== 'number' || h < 0) {
    problems.push(`catchup.minIntervalHours が不正です: ${h}`);
  }
  const d = config.catchup?.maxDays;
  if (typeof d !== 'number' || d < 1) {
    problems.push(`catchup.maxDays が不正です: ${d}`);
  }
  return problems;
}
