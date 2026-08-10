// guard.mjs — 編纂中の暴走から vault を守る安全弁。
//
// 編纂は LLM にファイルを書かせる作業なので、たまに触ってはいけない場所を触る。
// exbrain は git checkout で戻していたが、配布物では vault が git リポジトリ
// だとは限らない。そこで git に頼らず、自前でスナップショットを取る。
//
// 守り方は2段階にしてある。
//   復元する層  : daily/（kioku の管轄。壊れたら記録が失われる）
//   検知する層  : vault 内のその他（利用者の資産。勝手に巻き戻す方が危険なので報告だけ）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupDir } from './paths.mjs';
import { log } from './log.mjs';

/** 編纂で書き換わってよい場所。 */
export const WRITABLE_PATHS = [
  'entities',
  'concepts',
  'decisions',
  'open-loops.md',
  'INDEX.md',
];

/** 内容ごと退避して、変えられていたら戻す場所。 */
export const RESTORE_PATHS = ['daily'];

/** 走査から外す場所。Obsidian の作業ファイルと VCS。 */
const IGNORED_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.DS_Store']);

const MAX_FILES = 20_000;

function hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function isUnder(relPath, base) {
  return relPath === base || relPath.startsWith(base + '/');
}

/** 編纂で変わってよいファイルか。 */
export function isWritable(relPath) {
  return WRITABLE_PATHS.some((w) => isUnder(relPath, w));
}

function shouldRestore(relPath) {
  return RESTORE_PATHS.some((w) => isUnder(relPath, w));
}

/** vault 内のファイルを相対パスで列挙する。 */
export function listVaultFiles(vaultDir) {
  const out = [];
  const walk = (dir, prefix) => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile()) {
        out.push(rel);
        if (out.length >= MAX_FILES) return;
      }
    }
  };
  walk(vaultDir, '');
  return out;
}

/**
 * 編纂前の状態を控える。
 * 復元対象は実ファイルをコピー、それ以外はハッシュだけ持つ。
 */
export function snapshotVault(vaultDir) {
  const files = listVaultFiles(vaultDir);
  const hashes = new Map();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(backupDir(), stamp);

  for (const rel of files) {
    const abs = path.join(vaultDir, rel);
    let hash;
    try {
      hash = hashFile(abs);
    } catch {
      continue; // 読めないものは対象外
    }
    hashes.set(rel, hash);

    if (shouldRestore(rel)) {
      const dest = path.join(backupRoot, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
      } catch (err) {
        log(`退避に失敗: ${rel} (${err.message})`);
      }
    }
  }

  return { vaultDir, hashes, backupRoot, takenAt: Date.now() };
}

/**
 * 編纂後の状態を突き合わせる。
 * 保護層の改変は元に戻し、それ以外の想定外の変更は報告だけする。
 */
export function verifyAndRestore(snapshot) {
  const { vaultDir, hashes, backupRoot } = snapshot;
  const restored = [];
  const unexpected = [];
  const after = new Set(listVaultFiles(vaultDir));

  // 消された・書き換えられた保護層を戻す
  for (const [rel, beforeHash] of hashes) {
    if (!shouldRestore(rel)) continue;
    const abs = path.join(vaultDir, rel);
    const src = path.join(backupRoot, rel);
    let nowHash = null;
    try {
      nowHash = hashFile(abs);
    } catch {
      nowHash = null; // 消されている
    }
    if (nowHash === beforeHash) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(src, abs);
      restored.push(rel);
    } catch (err) {
      log(`復元に失敗: ${rel} (${err.message})`);
    }
  }

  // 保護層に生えた新規ファイルは、編纂が作ったものなので消す
  for (const rel of after) {
    if (!shouldRestore(rel) || hashes.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(vaultDir, rel));
      restored.push(`${rel}（新規作成を取り消し）`);
    } catch {
      /* 消せなくても記録は残す */
    }
  }

  // 書き換えてよい場所以外が変わっていたら報告する（戻しはしない）
  for (const [rel, beforeHash] of hashes) {
    if (shouldRestore(rel) || isWritable(rel)) continue;
    const abs = path.join(vaultDir, rel);
    let nowHash = null;
    try {
      nowHash = hashFile(abs);
    } catch {
      nowHash = null;
    }
    if (nowHash !== beforeHash) unexpected.push(rel);
  }

  return { restored, unexpected };
}

/** 退避を片付ける。直近1世代だけ残して古いものを消す。 */
export function cleanupBackups(keep = 1) {
  let stamps;
  try {
    stamps = fs.readdirSync(backupDir()).sort();
  } catch {
    return;
  }
  for (const s of stamps.slice(0, Math.max(0, stamps.length - keep))) {
    try {
      fs.rmSync(path.join(backupDir(), s), { recursive: true, force: true });
    } catch {
      /* 消せなくても実害はない */
    }
  }
}
