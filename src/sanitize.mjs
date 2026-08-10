// sanitize.mjs — vault に書き出す直前の最後の関門。
//
// エージェントとの会話には API キーも顧客のメールアドレスも普通に混じる。
// daily ノートは Obsidian に平文で残り、多くの人は同期や git に載せる。
// つまり「記録するかどうか」より「何を落とすか」の方が事故に効く。
//
// 判定は保守的にしてある。本文が多少読みにくくなっても、鍵が1本漏れるより良い。

import os from 'node:os';

const MAX_SANITIZED_CHARS = 4000;

// --- 秘密そのもの ---------------------------------------------------------

const MEMORY_CITATION_RE = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi;

const PRIVATE_KEY_RE =
  /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi;

const URL_RE = /https?:\/\/[^\s<>\])}]+/gi;

/** scheme://user:pass@host 形式。 */
const CREDENTIAL_URI_RE = /\b[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s/@:]*:[^\s/@]+@[^\s<>()]+/g;

/** API_KEY=xxx / "token": "xxx" のような代入。 */
const SECRET_ASSIGNMENT_RE = new RegExp(
  '(?<label>(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:' +
    'api[ _-]?key|access[ _-]?token|refresh[ _-]?token|' +
    'client[ _-]?secret|private[ _-]?key|secret[ _-]?access[ _-]?key|' +
    'client[ _-]?id|account[ _-]?id|tenant[ _-]?id|' +
    'database[ _-]?url|connection[ _-]?string|dsn|authorization|' +
    'password|passwd|token|secret))' +
    '(?<keyQuote>["\']?)(?<separator>\\s*[:=]\\s*)' +
    '(?<value>"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s,;}]+)',
  'gi'
);

const AUTHORIZATION_RE = new RegExp(
  '(?<prefix>\\b(?:proxy[-_])?authorization["\']?\\s*[:=]\\s*)' +
    '(?<value>"[^"\\n]*"|\'[^\'\\n]*\'|[^\\n]+)',
  'gim'
);

/** --api-key xxx / --token=xxx のようなコマンドライン。 */
const CLI_SECRET_RE = new RegExp(
  '(?<label>--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|' +
    'client[-_]?secret|private[-_]?key|password|token|secret))' +
    '(?<separator>=|\\s+)(?<value>"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s,;]+)',
  'gi'
);

/** 「APIキーは xxx」のような地の文。日本語の「は」も拾う。 */
const PROSE_SECRET_RE = new RegExp(
  '(?<label>\\b(?:api[ _-]?key|access[ _-]?token|' +
    'client[ _-]?secret|private[ _-]?key|secret[ _-]?access[ _-]?key|' +
    'password|token|secret))' +
    '(?<separator>\\s+(?:is|は)\\s+)' +
    '(?<value>"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s,;]+)',
  'gi'
);

const BARE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE_HEADER_RE = /^\s*(?:set-)?cookie\s*:[^\n]*$/gim;

const XML_SECRET_RE = new RegExp(
  '<(?<label>api[_-]?key|access[_-]?token|refresh[_-]?token|' +
    'client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|' +
    'password|token|secret)>[\\s\\S]*?<\\/\\k<label>>',
  'gi'
);

/** 形を見れば一発で分かるトークン。 */
const KNOWN_TOKEN_RE =
  /(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})/g;

const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// --- 個人情報 -------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const PRIVATE_DATA_LINE_RE =
  /^(?<label>\s*(?:phone|tel|telephone|電話|住所|address|生年月日)\s*[:：=]\s*).+$/gim;

const PHONE_RE = /(?<!\d)(?:\+\d{1,3}[\s-]?)?0\d{1,4}[-()\s]?\d{1,4}[-\s]?\d{3,4}(?!\d)/g;

// --- 表示を壊すもの -------------------------------------------------------

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// --- ローカルパス ---------------------------------------------------------
// ユーザー名が入った絶対パスは、vault を共有した瞬間に「誰の PC か」を晒す。
// macOS/Linux の /Users・/home に加え、Windows の C:\Users と
// Git Bash が渡してくる /c/Users も見る。

const LOCAL_PATH_TOKEN_RE =
  /(?:~\/|\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/]|\/[a-zA-Z]\/Users\/)[^\s<>()[\]{}'"`]+/g;

const SENSITIVE_PATH_PARTS = [
  '/.codex/',
  '/.claude/',
  '/.ssh/',
  '/.aws/',
  '/.gnupg/',
  '/.env',
  'auth.json',
  'credential',
  'keychain',
  'private_key',
  'private-key',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.p12',
];

const SENSITIVE_URL_PARTS = [
  '/oauth',
  '/authorize',
  'client_id=',
  'client_secret=',
  'code=',
  'state=',
  'token=',
  'key=',
  'secret=',
  'code_challenge=',
  'signature=',
  'sig=',
  'x-amz-credential=',
  'x-goog-credential=',
  'x-goog-signature=',
  'awsaccesskeyid=',
  'googleaccessid=',
  'key-pair-id=',
];

function isSensitiveUrl(url) {
  let lowered = url;
  // 二重エンコードされた認可 URL を素通りさせないため2回デコードする
  for (let i = 0; i < 2; i++) {
    try {
      lowered = decodeURIComponent(lowered);
    } catch {
      break; // 不正なエスケープならそこで打ち切る
    }
  }
  lowered = lowered.toLowerCase().replaceAll('&amp;', '&');
  return SENSITIVE_URL_PARTS.some((part) => lowered.includes(part));
}

function isSensitivePath(p) {
  const lowered = p.toLowerCase().replaceAll('\\', '/');
  return SENSITIVE_PATH_PARTS.some((part) => lowered.includes(part));
}

/** 値を伏せる。引用符で囲まれていたら囲みは残す（読みやすさのため）。 */
function redactValue(value) {
  const quote = value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")
    ? value[0]
    : '';
  return `${quote}[REDACTED]${quote}`;
}

/** 正規表現の特殊文字を無害化する。ホームディレクトリを文字列置換するのに使う。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ホームディレクトリの表記ゆれをまとめて ~ に畳む。
 * Windows では区切りが \ と / の両方で来るうえ、Git Bash 経由だと
 * /c/Users/name の形にもなる。3通りとも潰す。
 */
function foldHomeDir(text) {
  const home = os.homedir();
  if (!home) return text;

  const variants = new Set([home]);
  variants.add(home.replaceAll('\\', '/'));

  const winMatch = /^([A-Za-z]):[\\/](.*)$/.exec(home);
  if (winMatch) {
    const [, drive, rest] = winMatch;
    const slashed = rest.replaceAll('\\', '/');
    variants.add(`/${drive.toLowerCase()}/${slashed}`); // Git Bash
    variants.add(`/${drive.toUpperCase()}/${slashed}`);
  }

  let out = text;
  for (const v of variants) {
    if (!v) continue;
    out = out.replace(new RegExp(escapeRegExp(v), 'gi'), '~');
  }
  return out;
}

/**
 * 認証情報らしきものと、表示を壊す制御文字を落とす。
 * 順序に意味がある。広く当たる URL やパスの処理を先にやると、
 * その中の代入形式（?token=xxx）を個別ルールが拾えなくなる。
 */
export function sanitizeText(value) {
  if (typeof value !== 'string') return '';

  let text = value.replace(CONTROL_RE, '');
  text = text.replace(MEMORY_CITATION_RE, '[MEMORY CITATION OMITTED]');
  text = text.replace(PRIVATE_KEY_RE, '[PRIVATE KEY REDACTED]');
  text = text.replace(PRIVATE_DATA_LINE_RE, (...args) => {
    const groups = args[args.length - 1];
    return `${groups.label}[PRIVATE DATA REDACTED]`;
  });
  text = text.replace(PHONE_RE, '[PHONE REDACTED]');
  text = text.replace(XML_SECRET_RE, (...args) => {
    const groups = args[args.length - 1];
    return `<${groups.label}>[REDACTED]</${groups.label}>`;
  });
  text = text.replace(CREDENTIAL_URI_RE, '[CREDENTIAL URI REDACTED]');
  text = text.replace(URL_RE, (url) => (isSensitiveUrl(url) ? '[OAUTH URL REDACTED]' : url));
  text = text.replace(AUTHORIZATION_RE, (...args) => {
    const groups = args[args.length - 1];
    return `${groups.prefix}[REDACTED]`;
  });
  text = text.replace(SECRET_ASSIGNMENT_RE, (...args) => {
    const groups = args[args.length - 1];
    return groups.label + groups.keyQuote + groups.separator + redactValue(groups.value);
  });
  text = text.replace(CLI_SECRET_RE, (...args) => {
    const groups = args[args.length - 1];
    return groups.label + groups.separator + redactValue(groups.value);
  });
  text = text.replace(PROSE_SECRET_RE, (...args) => {
    const groups = args[args.length - 1];
    return groups.label + groups.separator + redactValue(groups.value);
  });
  text = text.replace(BARE_BEARER_RE, 'Bearer [REDACTED]');
  text = text.replace(COOKIE_HEADER_RE, 'Cookie: [REDACTED]');
  text = text.replace(KNOWN_TOKEN_RE, '[REDACTED]');
  text = text.replace(JWT_RE, '[REDACTED]');
  text = text.replace(EMAIL_RE, '[EMAIL REDACTED]');
  text = text.replace(HTML_COMMENT_RE, '[COMMENT OMITTED]');

  text = foldHomeDir(text);
  text = text.replace(LOCAL_PATH_TOKEN_RE, (p) =>
    isSensitivePath(p) ? '[SENSITIVE PATH REDACTED]' : p
  );

  if (text.length > MAX_SANITIZED_CHARS) {
    return text.slice(0, MAX_SANITIZED_CHARS - 1).trimEnd() + '…';
  }
  return text;
}

/**
 * サニタイズ済みの Markdown を、daily ノートに1行で置ける形にする。
 * 見出し・箇条書き・ウィキリンクをそのまま残すと、記録が
 * ノート本体の構造を壊してリンクグラフを汚す。
 */
export function compactText(value, limit = 300) {
  const lines = [];
  for (const rawLine of sanitizeText(value).split(/\r?\n/)) {
    let line = rawLine.replace(/^\s{0,3}(?:#{1,6}|[-*+]|>)\s*/, '');
    line = line.replaceAll('![[', '［［').replaceAll('[[', '［［');
    line = line.replaceAll(']]', '］］').replaceAll('`', "'");
    line = line.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  const compacted = lines.join(' / ') || '記録できる内容なし';
  if (compacted.length > limit) {
    return compacted.slice(0, limit - 1).trimEnd() + '…';
  }
  return compacted;
}

/**
 * ファイルパスを記録用に整える。
 * relativize が真なら、vault の外のパスもホーム基準に畳んでから返す。
 */
export function sanitizePath(filePath, { relativize = true } = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;
  let p = filePath;
  if (relativize) p = foldHomeDir(p);
  if (isSensitivePath(p)) return '[SENSITIVE PATH REDACTED]';
  return p.replaceAll('\\', '/');
}
