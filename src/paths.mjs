// paths.mjs — OS ごとに散らばる場所を1箇所に集める。
// Windows と macOS で違うのは実質「設定ファイルの置き場」だけなので、
// 差分をここに閉じ込めておけば他のモジュールは OS を意識しなくて済む。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function homeDir() {
  return os.homedir();
}

/** kioku 自身の作業場所。テスト時は KIOKU_HOME で差し替える。 */
export function kiokuHome() {
  return process.env.KIOKU_HOME || path.join(homeDir(), '.kioku');
}

/**
 * init が kioku 本体を据え置く場所。
 * ZIP で配ると「Downloads で展開して、あとで片付ける」が普通に起きる。
 * フックに展開先の絶対パスを焼くと、そこで記録が丸ごと止まるので、
 * 実体をここへ複製し、フックはこちらを指す。展開したフォルダは捨ててよい。
 */
export const appDir = () => path.join(kiokuHome(), 'app');

export const configPath = () => path.join(kiokuHome(), 'config.json');
export const statePath = () => path.join(kiokuHome(), 'state.json');
export const spoolDir = () => path.join(kiokuHome(), 'spool');
export const backupDir = () => path.join(kiokuHome(), 'backup');
export const logPath = () => path.join(kiokuHome(), 'kioku.log');
export const lockPath = () => path.join(kiokuHome(), 'compile.lock');

/** Claude Code のユーザー設定。フック注入先。 */
export function claudeSettingsPath() {
  return path.join(homeDir(), '.claude', 'settings.json');
}

/** Codex CLI のフック定義。Claude Code の settings.json とほぼ同形式。 */
export function codexHooksPath() {
  return path.join(homeDir(), '.codex', 'hooks.json');
}

export function codexConfigPath() {
  return path.join(homeDir(), '.codex', 'config.toml');
}

/** Obsidian 本体の設定ファイル。既存 vault の一覧がここに入っている。 */
export function obsidianConfigPath() {
  const home = homeDir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'obsidian', 'obsidian.json');
}

/**
 * インストール済み Obsidian から vault の一覧を読む。
 * Obsidian が入っていない環境では空配列。それは異常ではない。
 */
export function detectObsidianVaults() {
  const p = obsidianConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const vaults = parsed?.vaults;
  if (!vaults || typeof vaults !== 'object') return [];

  return Object.values(vaults)
    .filter((v) => v && typeof v.path === 'string')
    .map((v) => ({
      path: v.path,
      lastOpenedAt: typeof v.ts === 'number' ? v.ts : 0,
      isOpen: v.open === true,
      exists: fs.existsSync(v.path),
    }))
    .filter((v) => v.exists)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * vault を新規に作る場合の既定位置。
 * Windows の Documents は OneDrive にリダイレクトされていることがあり、
 * 同期の競合で Markdown が二重化する事故が起きやすい。ホーム直下に置く。
 */
export function defaultVaultDir() {
  return path.join(homeDir(), 'kioku-vault');
}

/** ~/.kioku 配下を作る。既にあれば何もしない。 */
export function ensureKiokuHome() {
  fs.mkdirSync(kiokuHome(), { recursive: true });
  fs.mkdirSync(spoolDir(), { recursive: true });
  return kiokuHome();
}

/**
 * フックや案内文から呼ぶ CLI の場所。
 *
 * init 済みなら ~/.kioku/app を指す。ZIP を展開したフォルダを移動・削除しても
 * 記録が止まらないようにするため。app が無いのは開発中にリポジトリから
 * 直接動かしている場合なので、そのときは自分自身を指す。
 */
export function cliPath() {
  const installed = path.join(appDir(), 'bin', 'kioku.mjs');
  return fs.existsSync(installed) ? installed : path.join(packageRoot(), 'bin', 'kioku.mjs');
}

/** ホーム配下なら ~ に畳んで表示する。Windows では畳まない（cmd が ~ を解さない）。 */
export function tilde(p) {
  if (process.platform === 'win32') return p;
  const home = homeDir();
  return p.startsWith(home + path.sep) ? p.replace(home, '~') : p;
}

/**
 * 案内文に出す、実際に打てるコマンド。
 * kioku は PATH に入れないので、案内も node 経由の形で揃える。
 * ここが実態とずれると、利用者は書いてあるとおり打って command not found を見る。
 */
export function invocation(sub = '') {
  const base = `node ${tilde(cliPath())}`;
  return sub ? `${base} ${sub}` : base;
}

/** このパッケージ自身の場所（templates/ や docs/ を読むため）。 */
export function packageRoot() {
  // URL の pathname は日本語などを %E6... のまま返すので、fileURLToPath で実際のパスに戻す
  // （Windows の /C:/... もここで C:\... になる）
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
