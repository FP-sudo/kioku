# kioku

Claude Code と Codex での作業を Obsidian に自動で記録し、夜ごとに知識へ編纂するツールです。

Mac でも Windows でも動きます。常駐プロセスもスケジューラ登録も要りません。

---

## 何が起きるか

インストールすると、あなたが何もしなくても daily ノートが埋まっていきます。

```markdown
## 作業ログ

### Claude Code（14:32〜15:10）

作業場所: `~/Projects/春のキャンペーンLP`

- 申し込みボタンのリンク先が旧URLのままになってる。6ページぶん直して
- UTAGEのカスタムHTMLに貼ったら保存できなかった。原因を調べて
- 64KB上限か。画像をセクション別PNGに分けて貼る方式に変更して

触ったファイル: `~/Projects/春のキャンペーンLP/final/lp.html`
```

そして翌日、次にエージェントを起動したタイミングで、この記録が知識に変換されます。

```
concepts/utage-64kb-limit.md
```

```markdown
# UTAGE のカスタムHTML は 64KB 上限。超過時はセクション別 PNG 分割方式に切り替える

## なぜそう言えるか

2026-08-10、キャンペーン LP（6ページ）をカスタムHTML に貼り込もうとしたところ、
容量超過で保存できなくなった [[daily/2026-08-10]]。

## どう使うか

1. HTML をセクションごとに分割
2. セクション単位を PNG として出力
3. PNG を UTAGE の画像管理機能で配置
```

半年後、同じ問題にぶつかったとき。あなたは「前にもあった気がする」で終わらず、`utage` で検索できます。

---

## 必要なもの

- Node.js 18 以上（`node --version` で確認できます。無ければ https://nodejs.org/ から入れてください）
- Claude Code または Codex CLI（片方でよい）
- Obsidian（無くても動きます。中身はただの Markdown フォルダなので）

編纂は Claude Code か Codex のサブスクリプション枠で動きます。**API キーは不要です。**

---

## インストール

配布された ZIP を、どこでもよいので展開します。展開したフォルダで1回だけ実行してください。

```bash
node bin/kioku.mjs init
```

`init` は4つのことをします。

1. 記録先の vault を決める（Obsidian が入っていれば既存の vault を候補に出します）
2. 雛形を置く（既にあるファイルには触りません）
3. 本体を `~/.kioku/app` に控える
4. Claude Code と Codex にフックを設定する

3 があるので、**展開したフォルダは init のあと消してかまいません。** フックが呼ぶのは
`~/.kioku/app` の方です。Downloads で展開してあとで片付ける、をしても記録は止まりません。

次にエージェントを起動した時点から、記録が始まります。

### コマンドを短く打てるようにする（任意）

kioku は PATH を書き換えません。そのままだと毎回こう打つことになります。

```bash
node ~/.kioku/app/bin/kioku.mjs status
```

面倒なら、`~/.zshrc`（bash なら `~/.bashrc`）にエイリアスを足してください。

```bash
alias kioku='node ~/.kioku/app/bin/kioku.mjs'
```

Windows の PowerShell なら、プロファイル（`$PROFILE`）に関数を1つ。

```powershell
function kioku { node "$HOME\.kioku\app\bin\kioku.mjs" @args }
```

**以降このドキュメントでは `kioku status` のように略記します。** エイリアスを作らない場合は、
`kioku` の部分を `node ~/.kioku/app/bin/kioku.mjs` に読み替えてください。

---

## 使い方

普段は何もしません。エージェントを普通に使うだけです。

たまに様子を見たくなったら:

```bash
kioku status     # 記録と編纂の状況
kioku doctor     # 動かないときの原因切り分け
kioku compile    # 溜まった記録を今すぐ編纂する
```

外すときは `kioku uninstall`。自分が入れたフックだけを取り除き、あなたが元から使っていたフックには手を出しません。

### 新しい版が届いたら

新しい ZIP を展開して、そのフォルダで `node bin/kioku.mjs init` をもう一度実行してください。
`~/.kioku/app` が入れ替わり、フックも張り直されます。設定（`~/.kioku/config.json`）と
これまでの記録はそのまま残ります。古い展開フォルダは消してかまいません。

---

## 記録されるもの、されないもの

daily ノートに残るのは、**あなたがエージェントに出した依頼文**と、**触ったファイルのパス**です。
エージェントの返答や、ファイルの中身は記録しません。

書き出す直前に、20種類以上のパターンで秘密を落としています。

| 落とすもの | 例 |
|---|---|
| API キー・トークン | `sk-...`、`ghp_...`、`AKIA...`、JWT、Bearer |
| 代入形式の秘密 | `API_KEY=xxx`、`"client_secret": "xxx"`、`--token xxx`、「APIキーは xxx」 |
| 秘密鍵 | `-----BEGIN ... PRIVATE KEY-----` ブロックごと |
| 認可 URL | `?code=`、`?token=` を含む URL（二重エンコードも展開して判定） |
| 個人情報 | メールアドレス、電話番号、`住所:` で始まる行 |
| 認証情報の置き場 | `~/.ssh/`、`~/.aws/`、`.env`、`auth.json` などのパス |

ユーザー名を含む絶対パスは `~/` に畳みます。vault を共有しても「誰の PC か」は残りません。

人名と会社名は**残します**。消すと知識にならないからです。お客様の氏名や連絡先などの個人情報を依頼文に書く作業では、設定で依頼文の記録自体を切ってください（`record.requests` を `false`）。記録はあなたの PC の vault に保存され、編纂のときだけ、普段使っている Claude Code / Codex に読み込ませます。不要になった daily ノートは自分で削除できます。

---

## 仕組み

### 4つの層

```
daily/         その日の記録。自動で溜まる。編纂は読むだけ
  ↓
entities/      人・会社・ツール・案件      固有名詞が出たら作る
concepts/      学び・判断基準・型          原因と対策が揃ったときだけ
decisions/     金額・契約・方針の決定
open-loops.md  未解決の宿題
  ↓
INDEX.md       全体の地図
```

entities と concepts で基準の厳しさを変えているのは意図的です。同じ厳しさにすると、
実測では「すべて定型作業」と判定されて何も書かれないまま終わりました。
名前は記録の取っかかりなので、緩くてよいのです。

### 編纂の3原則

1. **差分最小** — 既存ページを全面書き直ししない
2. **追記のみ** — 既存の記述を消さない
3. **出典必須** — すべての追記に `[[daily/YYYY-MM-DD]]` を付ける

この3つが無いと、編纂は「毎晩ノートを書き直す機械」になります。数週間で、自分の記録の
どこまでが事実か分からなくなる。

### 安全弁

編纂は LLM にファイルを書かせる作業なので、たまに触ってはいけない場所を触ります。
そこで編纂の前後で vault のハッシュを取り、2段階で守っています。

- **`daily/` は元に戻す** — kioku の管轄。書き換えられても消されても復元します
- **それ以外は報告だけ** — あなたのノートを勝手に巻き戻す方が危険なので、変更を検知して知らせるに留めます

git は使いません。あなたの vault が git リポジトリでなくても動きます
（リポジトリなら、設定で自動コミットを有効にできます）。

### 常駐しない

スケジューラを登録する代わりに、**エージェントを起動したときに追いつく**方式にしています。
前回の編纂から一定時間（既定は20時間）が経っていれば、切り離したプロセスで編纂を始めます。
エージェントの起動＝作業を始める瞬間なので、そこで前日ぶんを片付ければ足ります。

Windows でタスクスケジューラを設定させる手順が要らないのは、この設計のためです。

---

## 設定

`~/.kioku/config.json` を直接編集します。

```json
{
  "vaultDir": "/Users/you/my-vault",
  "compiler": "auto",
  "claudeModel": "claude-haiku-4-5",
  "compileTimeoutMinutes": 15,
  "record": {
    "requests": true,
    "files": true,
    "relativizePaths": true,
    "maxRequestChars": 300
  },
  "catchup": {
    "enabled": true,
    "minIntervalHours": 20,
    "maxDays": 3
  },
  "git": { "autoCommit": false }
}
```

| 項目 | 意味 |
|---|---|
| `compiler` | `auto` / `claude` / `codex`。auto は入っている方を自動で選ぶ |
| `compileTimeoutMinutes` | 1日ぶんの編纂に許す時間。記録量が多い日や重いモデルでは延ばす |
| `record.requests` | 依頼文を記録するか。false にすると日付と作業ファイルだけになる |
| `record.relativizePaths` | ホーム配下の絶対パスを `~/` に畳む |
| `catchup.maxDays` | 1回で編纂する日数の上限。長期離脱後に何十日ぶんも回さないための蓋 |

---

## よくある質問

**API 料金はかかりますか**
かかりません。Claude Code / Codex のサブスクリプション枠で動きます。

**編纂にどれくらい時間がかかりますか**
Claude Code（haiku）で1日ぶん30秒前後です。記録量によって変わります。

**Obsidian は必須ですか**
不要です。中身はただの Markdown ファイルなので、好きなエディタで読めます。

**既に Obsidian vault を使っています。壊れませんか**
`init` は既にあるファイルには一切触りません。編纂も、`entities/` `concepts/` `decisions/`
`open-loops.md` `INDEX.md` 以外は書き換えません。それ以外が変わった場合は警告として報告します。

**Codex の MCP 設定や config.toml は使われますか**
使いません。編纂は `--ignore-user-config` で起動します。`codex exec` は起動時に
config.toml の MCP サーバーを全部立ち上げようとするため、到達できないサーバーや
認証切れのものが1つあるだけで編纂が丸ごと時間切れになります（実測で15分でも終わりませんでした）。
編纂に MCP は不要で、認証情報は `CODEX_HOME` から別途読まれるので動作に支障はありません。

**Cursor は対応していますか**
していません。Claude Code と Codex のみです。

**エージェントの起動時にエラーが出るようになりました**
`kioku doctor` を実行してください。`~/.kioku/app` が消えている場合は「フックが指す先」の項が
赤くなり、直し方が出ます。ZIP を展開し直して `node bin/kioku.mjs init` で戻ります。

**それでも分からないとき**
`kioku doctor` の出力を添えて、[GitHub の Issues](https://github.com/FP-sudo/kioku/issues) に書いてください。
どこで止まっているかは、たいていその出力に出ています。

---

## 開発

```bash
node --test          # テスト（40件）
```

## ライセンス

MIT
