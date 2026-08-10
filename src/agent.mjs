// agent.mjs — 編纂を実行するエージェントの起動まわり。
//
// claude と codex はフラグ体系が違うだけで、やらせることは同じ。
// 「vault を作業ディレクトリにして、プロンプトを stdin から渡し、
//  ファイル編集を許して、終わるまで待つ」——差分はこのファイルに閉じ込める。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { homeDir } from './paths.mjs';
import { log } from './log.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * PATH と、よくある導入先を順に見る。
 * シェル関数でラップされていても、実体さえ見つかれば直接起動できる。
 */
function findExecutable(name) {
  const isWin = process.platform === 'win32';
  const exeNames = isWin ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extraDirs = isWin
    ? [
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', name),
      ]
    : [
        path.join(homeDir(), '.local', 'bin'),
        path.join(homeDir(), '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];

  for (const dir of [...pathDirs, ...extraDirs]) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* 次の候補へ */
      }
    }
  }
  return null;
}

let cache = null;

/** 使えるエージェントを探す。結果はプロセス内で使い回す。 */
export function detectCompilers({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  cache = {
    claude: findExecutable('claude'),
    codex: findExecutable('codex'),
  };
  return cache;
}

/**
 * 設定と実際に入っているものから、使う実行系を1つ決める。
 * auto のときは claude を優先する（安いモデルを明示指定できる分、
 * 毎晩走らせる用途では費用が読みやすい）。
 */
export function resolveCompiler(config) {
  const found = detectCompilers();
  const wanted = config?.compiler ?? 'auto';

  if (wanted === 'claude' || wanted === 'codex') {
    return found[wanted] ? { kind: wanted, bin: found[wanted] } : null;
  }
  if (found.claude) return { kind: 'claude', bin: found.claude };
  if (found.codex) return { kind: 'codex', bin: found.codex };
  return null;
}

function buildArgs(compiler, { vaultDir, config }) {
  if (compiler.kind === 'claude') {
    const args = ['-p', '--permission-mode', 'acceptEdits'];
    if (config.claudeModel) args.push('--model', config.claudeModel);
    // 編纂に必要なのは読み書きと探索だけ。Bash も web も渡さない。
    args.push('--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep');
    return args;
  }
  // codex の注意点が3つある。
  //   --skip-git-repo-check : vault は git リポジトリとは限らない
  //   --ephemeral           : セッションログを残さない（記録の二重化を避ける）
  //   --ignore-user-config  : 利用者の config.toml を読まない
  //
  // 3つ目が特に効く。codex exec は起動時に config.toml の MCP サーバーを
  // 全部立ち上げようとするため、認証切れや到達不能なサーバーが1つあるだけで
  // 編纂が丸ごと時間切れになる（実測: MCP 多数の環境で15分でも終わらなかった）。
  // 編纂に MCP は要らない。認証は CODEX_HOME から別途読まれるので影響しない。
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '-s',
    'workspace-write',
    '-C',
    vaultDir,
  ];
  if (config.codexModel) args.push('-m', config.codexModel);
  args.push('-'); // プロンプトは stdin から
  return args;
}

/**
 * 編纂を1回走らせる。
 * プロンプトはコマンドライン引数ではなく stdin で渡す。
 * Windows の引数長制限（約32KB）を避けられるうえ、
 * プロセス一覧に指示文が丸ごと出るのも防げる。
 */
export function runCompilerAgent({ compiler, prompt, vaultDir, config, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = buildArgs(compiler, { vaultDir, config });
  log(`編纂を起動: ${compiler.kind} ${args.join(' ')}`);

  return new Promise((resolve) => {
    const child = spawn(compiler.bin, args, {
      cwd: vaultDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err.message), timedOut: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });

    child.stdin.on('error', () => {
      /* 相手が先に閉じた場合。close 側で扱う */
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/** vault が git リポジトリなら、編纂結果をコミットする。 */
export function commitIfGitRepo(vaultDir, message) {
  if (!fs.existsSync(path.join(vaultDir, '.git'))) return null;
  const git = findExecutable('git');
  if (!git) return null;

  const run = (args) =>
    spawnSync(git, args, { cwd: vaultDir, encoding: 'utf8', windowsHide: true });

  // 編纂で変わってよい場所だけを対象にする。
  // git add -A にすると、利用者が置いた下書きや秘密ファイルまで巻き込む。
  for (const p of ['entities', 'concepts', 'decisions', 'open-loops.md', 'INDEX.md']) {
    if (fs.existsSync(path.join(vaultDir, p))) run(['add', '--', p]);
  }
  const staged = run(['diff', '--cached', '--name-only']);
  if (!staged.stdout?.trim()) return null;

  const result = run(['commit', '-m', message]);
  return result.status === 0 ? staged.stdout.trim().split('\n') : null;
}

export function tmpDir() {
  return os.tmpdir();
}
