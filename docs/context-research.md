# Context Engineering Research — 次世代 coding agent harness の設計指針

調査日: 2026-11-19

## 0. 要約（TL;DR）

- **最適化の目的関数は「context 長」ではなく「完了タスクあたりの総コスト（$/task）＋品質」**。context を短く保つ施策は、prompt cache を壊すとかえって高くつく。逆に「全履歴を毎回そのまま送る」append-only 戦略は cache hit 率 99% 台を出せるが、context の劣化（context rot）と長さによるレイテンシーを抱える。両極の間を **コストモデルで判断する harness** を作るのが本設計の核。
- 主要プロバイダーでは cache read が通常入力の 1/10〜1/50 程度（Anthropic Opus 5.5/Sonnet 5.5 は 0.05×、DeepSeek は二次情報で約 1/50〜1/120）。このため **「履歴の途中を消す」操作は、消した位置より後ろをすべて再書き込みするコスト**になる。損益分岐は概算で `残りターン数 N ≥ (w−r)/r × T/X`（X=削除量、T=削除位置より後ろの量）。Opus 5.5 なら `N ≥ 24·T/X` になる。履歴の深いところを少し消しても、まず元は取れない。
- そこで設計原則は次の 5 つにする。
  1. **入口で絞る（Gate at the edge）**: 不要な情報は履歴に入る前に止める。Code Mode／outline-first 読み込み／大きな出力をファイルへ退避、の 3 つで対応する。
  2. **探索は分岐で行い、要約だけを main に合流させる（Branch & Merge）**: キャッシュ済み prefix を共有する短命の fork で探索し、main には要約だけを append する。Codex で問題になった「長命・並列・全履歴 fork」は既定で禁止する。
  3. **削除はまとめて、cache が冷えたときに行う（Prune on cold cache）**: 削除候補は tombstone として溜めておき、TTL 切れ（ユーザーの離席など）や compaction のタイミングで一括適用する。この時点では再書き込みが元々避けられないので、追加コストはほぼゼロになる。
  4. **prefix は凍結し、変わる情報は末尾に置く**: system とツール定義は session 中に変えない。todo やリマインダーは末尾に append する。シリアライズは決定的にする。
  5. **計測を前提にする**: cache hit 率、$/task、再読込率（削りすぎの兆候）、sub-agent のトークン倍率を常時計測し、CI で prefix 破壊を検知する。

---

## 1. 背景: コストを決める式

1 回の API 呼び出しのコストは、だいたい次の式で決まる。

```
cost = uncached_input × p_in + cache_write × w + cache_read × r + output × p_out
```

Anthropic（2026-11 時点の公式資料）の値:

| モデル | input $/MTok | cache read | cache write (5m TTL) | cache write (1h TTL) |
|---|---|---|---|---|
| Claude Opus 5.5 | 4.00 | 0.20（0.05×） | 1.25× | 2× |
| Claude Sonnet 5.5 | 2.00 | 0.10（0.05×） | 1.25× | 2× |
| Claude Fable 5.2 | 8.00 | 0.20（0.025×） | 1.25× | 2× |
| その他の多く | — | 0.1× | 1.25× | 2× |

その他の制約: breakpoint は最大 4 個、最小キャッシュ長はモデル依存（512〜4096 tok）、各 breakpoint が前回エントリを遡れるのは 20 ブロックまで、TTL はリクエストの**開始**時点から数える（read のたびに更新）。キャッシュはモデルごとに分かれる。

他社の状況（二次情報が多い。数値は必ず公式で再確認すること）:
- **DeepSeek**: ディスクベースの自動 prefix cache で write 料金はない。hit 単価は miss のおよそ 1/50〜1/120（V4 Flash で hit $0.0028 / miss $0.14 という報告がある）。append-only を徹底すると最も得をするプロバイダー。
- **OpenAI**: 自動 prefix caching。モデル世代によっては write に割増があるという報告もあり、情報が錯綜している。
- **Gemini**: implicit cache（自動）と explicit cache（TTL 指定、保存料金あり）の 2 種類。

**含意**: エージェントループでは入力トークンが支配的になる（JetBrains の研究では SWE-agent の 1 ターンの約 84% が observation＝ツール出力）。入力の 9 割以上を cache read にできるかどうかで、コストは数倍から 10 倍以上変わる。

### 1.1 削除の損益分岐（本設計の基本式）

キャッシュ済みの履歴の途中から X トークンを消し、その位置より後ろに T トークンあるとする。残りターン数を N とする。

- 消さない場合の追加コスト: `X · r · N`
- 消す場合の追加コスト: `T · (w − r)`（後ろ全体を 1 回再書き込み）
- 損益分岐: **`N* = T(w−r) / (X·r)`**

| 例 | X | T | Opus 5.5 (w=1.25,r=0.05) | DeepSeek (w≈1, r≈0.02) |
|---|---|---|---|---|
| 直前のツール結果を即座に捨てる | 20k | 2k | N* ≈ 2.4 | N* ≈ 4.9 |
| 30 ターン前の 20k 出力を捨てる | 20k | 60k | N* ≈ 72 | N* ≈ 147 |
| 古い出力を一括で 80k 捨てる | 80k | 100k | N* ≈ 30 | N* ≈ 61 |
| **cache が切れた後（TTL 超過）** | 任意 | 任意 | **N* ≈ 0**（いずれ全体を再書き込みするため） | 同左 |

ここから 3 つの結論が出る。(a) 捨てるなら**すぐ**捨てる。(b) 古いものは**まとめて**捨てる。(c) **cache が冷えたとき**に捨てる。さらに、Anthropic の新しいモデル（Opus 5.5／Sonnet 5.5／Fable 5.x など）では、履歴を編集すると **preserved thinking の thinking block が無効になる**という品質面のコストもある（history-editing check）。この点からも、可能な限り append-only に寄せるべきである。

---

## 2. 市場調査

### 2.1 ツール呼び出しのコード化（Code Mode 系）

| 事例 | 仕組み | 報告された効果 | 注意点 |
|---|---|---|---|
| **Cloudflare Code Mode**（2025-09）／**Code Mode MCP server**（2026） | MCP ツールを TypeScript API に変換し、LLM には `codemode({code})` 相当のツールを 1 つだけ見せる。コードは V8 isolate（Dynamic Worker Loader）で実行する。FS／env なし、外部 fetch は既定で無効、binding 経由でのみ外部にアクセスする。**最終出力だけが context に戻る** | 2,500 以上の endpoint の API 定義が 117 万トークン→約 1,000 トークンになったと Cloudflare が主張。別のベンチでは単純タスクで -32%、バッチ処理で -81% | 認可・監査（下流の操作を誰が承認したか）の論点が残る。単純なタスクでは効果が小さい |
| **Anthropic "Code execution with MCP"** | MCP サーバーをファイルツリー上のコード API として見せ、必要な定義だけを読ませる。中間データは実行環境の中で処理する | ある例（Drive→Salesforce）で 15 万→2,000 トークン（-98.7%） | 単一事例。output トークンは増える（独立検証では 2.2 倍） |
| **Anthropic Programmatic Tool Calling (PTC)** | `code_execution` の中からカスタムツールを関数として呼ぶ（`allowed_callers`）。Claude には最終出力だけが返る | 中間結果ぶんのトークンとラウンドトリップを削減 | strict／強制 tool_choice／MCP ツールとは併用できない |
| **AIMultiple の独立検証** | GPT-4.1 とブラウザ MCP で比較 | 入力 -78.5%（77.1 万→16.5 万）、成功率は同じ | output は 2.2 倍 |

**示唆**: Code Mode は「ツールを使うたびに結果を context に入れる」をやめ、**フィルタ・結合・集約をサンドボックスの中で済ませる**ための仕組みである。output トークン（コード生成）は増えるので、短い単発の呼び出しでは JSON tool call のほうが安いことがある。両方を併用できるハイブリッドにするべきである。

### 2.2 ツール定義の遅延ロード

| 事例 | 仕組み | 効果 |
|---|---|---|
| **Anthropic Tool Search** (`defer_loading`) | 定義は送るが、context に載るのは検索で見つかったものだけ（regex／BM25）。読み込んだ定義は **append されるので cache を壊さない** | よく使う 3〜5 個は非 defer にするのが推奨 |
| **Cursor Dynamic Context Discovery**（2026-01） | MCP ツールの説明をフォルダに同期し、最初はツール名だけを見せる。shell や MCP の大きな出力はファイルに書き出して grep させる | MCP を使った run で総トークン -46.9%（Cursor 社内の A/B テスト） |
| **Claude Code Skills** | SKILL.md の frontmatter（name／description）だけを常に読み込み、本文と参照ファイルは使うときに読み込む（3 段階の progressive disclosure） | 固定の context を小さく保てる |
| **Manus** | ツールを増減するとキャッシュが壊れるので、**ツールは消さずに logit masking で選べなくする**。名前に prefix（`browser_`／`shell_`）を付けてグループ単位で制御 | KV-cache hit 率を「本番エージェントで最も重要な指標」と位置付けている |

### 2.3 大きな出力・文書の扱い

- **Claude Code**: MCP の出力が 1 万トークンで警告、2.5 万トークンが既定の上限。上限を超えたら tool-results ディレクトリに保存し、パスとプレビューだけを返す。JSON には jq、テキストにはチャンクサイズ計算を案内する（v2.1.105）。既知の失敗例として「プレビューを全文だと思い込む」問題がある → **プレビューには必ず「切り詰め済み・全体サイズ・続きの読み方」を明示する**必要がある。
- **Aider repo map**: tree-sitter で定義と参照のグラフを作り、personalized PageRank で順位付けして、トークン予算（既定 1k、空のセッションでは 2k）に収まる範囲だけを出す。SQLite に mtime をキーとしてキャッシュする。
- **11 種の harness のソースコード調査**（arXiv:2609.00006）: 11 システムすべてが決定的な検索（ripgrep／tree-sitter／glob／Markdown のコンテキストファイル）を使っており、**ベクトル検索を使うものはなかった**。11 中 7 は閾値ベースの compaction。

### 2.4 履歴の圧縮・削除

| 事例 | 方式 | 知見 |
|---|---|---|
| **JetBrains "The Complexity Trap"**（2025-12） | Observation masking（古いツール出力をプレースホルダーに置換）と LLM 要約を比較 | **どちらもコストを半分以下にし、masking は要約と同等以上**。ハイブリッドでさらに -7%（対 masking）、-11%（対要約） |
| **Anthropic context editing** | `clear_tool_uses_20250919`（古いツール結果を消す。inputs を残すかは選択可）、`clear_thinking_20251015` | memory tool と組み合わせて +39%、context editing 単独で +29%（社内評価） |
| **Anthropic server-side compaction** | 閾値（既定 15 万トークン）で過去を要約して compaction block にする | `response.content` を丸ごと戻さないと compaction の状態が失われる |
| **Claude Code** | 段階的なパイプライン（Snip → Microcompact → Collapse → AutoCompact と報告されている） | ルールは CLAUDE.md などの永続ファイルに置き、要約に頼らないのがよい |
| **Codex CLI** | compaction 結果を不透明な encrypted blob で返す | 中身を確認できない |
| **OpenCode／Gemini CLI** | OpenCode は window の 96〜99% で発動、Gemini CLI は 50% 程度で発動 | 発動の閾値は実装ごとに大きく違う |
| **Factory.ai** | 圧縮の評価に「artifact trail」（どのファイルを読み、どう編集したか）という観点を入れる | これが欠けると、同じファイルの再読込や矛盾した編集が起きる |
| **Morph** | 逐語的な compaction／LLM 要約／不透明圧縮を比較 | コーディングでは正確なパス・エラー文字列が重要なので、逐語的な方式が精度と検査可能性で優れる |
| **OpenCode 上の compaction 5 戦略の比較論文** | 長期ベンチマーク 3 種 | 既定の自己要約に対して一貫した改善はなかった → **凝った手法より計測が先** |
| **compaction のコスト** | 12.5 万トークンの compaction 1 回 ≈ $0.40 ≈ cached read 21 ターン分という試算 | compaction 自体も cache を壊すイベントである |

### 2.5 Cache-first（append-only）系

- **Pi**: 既定ツールは 4 つ（read／write／modify／execute）だけで、それ以外は拡張で足す。system prompt とツール定義を固定する。DeepSeek V4 Flash で **cache hit 率 99.93%**、約 10 億入力トークンで約 $2.65（キャッシュなしなら推定 $132）という報告がある。他の harness では 94〜97% にとどまるという比較もある（いずれも個人の計測）。
- **Reasonix**（DeepSeek 専用）: 長いセッションで hit 率 90% 超、Claude と比べて -93% という自己申告。
- **Hermes Agent の提案（"Append-Only Coding"）**: 履歴の書き換えを一切しない設計を提案している。
- **よくある失敗**: 毎ターン system にタイムスタンプを入れる、JSON のキー順が不安定、履歴の並べ替え・書き換え → hit 率が 20% 未満まで落ちるという指摘もある（未検証）。
- **Manus**: append-only と決定的シリアライズを徹底する。圧縮は**元に戻せる形**（URL やパスを残して、本文は再取得可能にする）。ファイルシステムを「無制限の context」として使う。

> 注: ユーザーが示した Reddit スレッド（r/DeepSeek の cache hit 率）は直接取得できなかった（取得ツールが拒否された）。上記は同じ話題の公開記事・HN・GitHub issue から再構成したものである。

### 2.6 Sub-agent のコスト問題

- **Codex MultiAgent V2**: `spawn_agent` は `fork_turns` を省略すると `"all"`、つまり**全履歴 fork** になる。全履歴 fork では model／agent_type／reasoning_effort の上書きができない（＝安いモデルに切り替えられない）。報告されている事例:
  - 長いスレッドから 360 個の sub-agent を hydrate した場合、新規セッションから 352 個を起動した場合の **2.6 倍**の使用量
  - 上位モデルの root が同じモデルの子を 7 体起動し、1 セッションで 3.8 億トークン
  - 親が約 27 万トークンの状態で、全履歴の子を 3 体起動
  - ただし ccusage では fork 分を二重に数えていた可能性があり、一部は計測上の見かけでもある。
  - 回避策: `fork_turns:"none"`／直近 N ターンだけ渡す、先に compaction してから fork する（openai/codex #12431、#20077、#53752）。
- **Anthropic の multi-agent research**: エージェントはチャットの約 4 倍、multi-agent は約 **15 倍**のトークンを使う。価値の高いタスクに限るべき、と Anthropic 自身が述べている。また「コーディングは並列化しにくい」とも述べている。

> 注: OpenAI Developer Community のスレッドは直接取得できなかった（DNS 解決に失敗）。上記は関連する GitHub issue と解説記事から再構成したものである。

---

## 3. 設計提案

### 3.1 Context のレイヤー構造

```
┌────────────────────────────────────────────────────────────┐
│ L0 凍結層   system / コアツール定義 / ツール索引スタブ         │ ← breakpoint #1 (1h TTL も検討)
│             （session 中に絶対に変えない）                    │
├────────────────────────────────────────────────────────────┤
│ L1 session 層  プロジェクトメモリ (AGENTS.md 等) / repo map 概要  │ ← breakpoint #2
├────────────────────────────────────────────────────────────┤
│ L2 transcript  append-only。要約・handle・結論を中心に積む       │ ← 自動 breakpoint（末尾追従）
│                （生データは L2 に入る前に絞る）                 │   ＋ 長いターンは中間 breakpoint
├────────────────────────────────────────────────────────────┤
│ L3 揮発層   todo / リマインダー / 現在時刻 / 環境の差分           │ ← ターン単位。末尾に append、
│             （clear_at: next_user_message 相当）              │   削除はしない
└────────────────────────────────────────────────────────────┘
```

- system の変更、ツールの追加・削除、effort の変更は、**messages の中への system message／tool_addition／per-message effort** で表現する（Anthropic の新しいモデルで利用可能。cache を壊さない手段）。対応していないプロバイダーでは、`<system-reminder>` を user ターンの末尾に入れる方式にフォールバックする。
- 時刻、乱数 ID、ソート順の不定な dict を L0／L1 に置かない。JSON は**キーをソートし、空白を正規化して**シリアライズする。
- 長いターン（同じターン内で 20 ブロックを超える）では約 15 ブロックごとに中間 breakpoint を置く（lookback の取りこぼし対策）。

### 3.2 ツール面: 「少数のコアツール＋Code Mode ランタイム＋カタログ」

1. **コアツール**（常に読み込み、定義は固定、5〜7 個）: `read`（outline 対応）、`edit`、`search`（ripgrep／symbol）、`bash`、`run_code`（TS ランタイム）、`ask_user`。
   - Pi が示すとおり、ツール数の少なさと定義の固定性はそのまま cache 効率につながる。
2. **TS ランタイム（Code Mode）**
   - MCP サーバーごとに TypeScript の型定義（`.d.ts`）を生成し、仮想 FS（例: `/tools/<server>/<tool>.d.ts`）に配置する。モデルは `ls`／`read` で必要な定義だけを読む（Anthropic 方式）。BM25 などの検索ツールを併用してもよい（Tool Search 方式）。
   - 実行は隔離サンドボックス（V8 isolate／Deno／WASM）で行う。外部へのアクセスは binding 経由に限り、資格情報はホスト側で注入する。サンドボックスには資格情報を置かない。
   - **出力の契約**: `return` または `console.log` に書いた値だけが context に戻る。既定の上限（例: 4k トークン）を超えたら自動でファイルに退避し、「プレビュー＋切り詰め済み・全体サイズ・続きの読み方」を返す（Claude Code の失敗例への対策）。
   - **REPL の状態を保持する**: ターンをまたいで変数を保持し、大きな結果は handle（`$r1` など）として持ち越す。context に再投入しなくても後のコードから参照できる。
   - 副作用のある MCP 呼び出し（送信・削除・課金）は binding 側で**承認ゲート**を通す。Code Mode では harness が個々の呼び出しを見えなくなる、という弱点を binding 層で補う。
3. **JSON tool call との使い分け**: 単発で小さな呼び出しは従来の tool call のほうが output トークン的に安い。モデルにはこう指示する: 「複数のツールを連鎖させる／大きな結果をフィルタする／ループする場合は run_code を使う」。

### 3.3 段階的な読み込み（Outline-first reading）

`read` ツールの既定動作を「全文」から「**全文か outline かを自動で選ぶ**」に変える。小さいファイルは全文を返し、大きいファイルは outline を返す。

| 形式 | outline の内容 | 次の一手 |
|---|---|---|
| Markdown | 見出しツリー＋**各節のトークン数**＋先頭 1 行 | `read path#見出しスラッグ` で節単位に読む |
| ソースコード | tree-sitter によるシンボル一覧（シグネチャ、行範囲、docstring の 1 行目） | `read path:symbol` または行範囲 |
| JSON／YAML | 形（キー、型、配列長、サンプル 1 件） | jq 式、または run_code で抽出 |
| ログ／テスト出力 | 先頭・末尾＋エラー行の抽出＋件数 | grep／範囲指定 |
| ディレクトリ | repo map（Aider 方式の PageRank、予算付き） | 個別の read |

- outline に節ごとのトークン数を出すことで、モデルが「読むコスト」を見積もれるようになる。
- 自動選択の閾値（例: 300 行／4k トークン）は、計測した**再読込率**を見て調整する。

### 3.4 探索の分岐と合流（Branch & Merge）— 探索で不要になったコードを残さない

「探索した結果、不要だったコード」を main context に残さないための中心となる仕組み。

**方式 A: Cache-sharing fork（短命・逐次）**
- main の現在の prefix をそのまま引き継いだ fork（同じモデル・同じツール・同じバイト列）で探索させる。fork の各ターンは main の cache を **read で共有**するので、inline で探索した場合とほぼ同じ単価になる。
- 探索が終わったら、fork は**構造化した結論**（関連ファイル・シンボル・根拠の行範囲・不要と判断した候補の一覧、上限は例えば 1.5k トークン）を返す。main にはこの結論だけを append し、fork の transcript は捨てる。
- 経済性: inline 探索で生じたゴミ J トークンが残り N ターン載り続けるコスト `J·r·N` が、結論 s トークン分の `s·w + s·r·N` に置き換わる。**探索中のコストは同じで、探索後のコストが下がる**ので、N が大きいほど得になる。
- 制約: **並列にしない（既定は 1）、短命（ターン数と予算の上限あり）、再帰 fork は禁止**。これが Codex の全履歴 fork 問題（長命・並列・多段）との違いになる。

**方式 B: Fresh sub-agent（独立 context）**
- 親の context が大きく、タスクがそれをほとんど必要としない場合（例: 「この 30 ファイルから X を使っている箇所を列挙して」）に使う。
- 安いモデル（例: Haiku クラス）を使える。キャッシュはモデルごとに分かれるので、fork ではモデルを変えられない。
- 親は明示的な brief（目的、既知の事実、出力スキーマ、予算）を書く。brief の質が成否を決める。

**どちらを選ぶかの目安**（harness が自動計算して提案する）:
```
fork_cost   ≈ E_turns × (P + g) × r_main               # P=親 prefix, g=探索中の増分
fresh_cost  ≈ (S + brief) × w_sub + E_turns × (S + g) × r_sub   # S=sub の固定 prefix
```
P が大きく安いモデルで足りる場合は B、親の文脈（設計の議論など）が必要な場合は A。

**ガードレール（Codex の教訓）**
- 既定は fresh または直近 K ターンだけ渡す。全履歴 fork は明示的に指定した場合だけ許可し、その場合も**先に compaction してから** fork する。
- 同時に動く sub-agent の数、sub-agent の深さ、session 全体のトークン予算に上限を設ける。
- sub-agent の usage は**親 session に紐付けて重複なしで**集計する（ccusage の二重計上問題を避ける）。

### 3.5 削除・圧縮のポリシー（Prune scheduler）

1. **即時ドロップ（入口）**: ツール結果を見た直後のターンで「不要」と判断した場合、後ろにまだ何もない（T が小さい）ので、損益分岐 N* が小さく安い。モデルに `discard(result_id, reason)` を出させ、harness が次のリクエストでプレースホルダーに置き換える。
2. **Tombstone の蓄積**: 古い出力の削除候補には印を付けるだけにする。プレースホルダーの形式は Manus と JetBrains の方式に倣い、**元に戻せる形**にする: `[elided: read src/foo.ts L1-400, 6.2k tok — re-read with read("src/foo.ts")]`。
3. **一括適用のタイミング**（どれか 1 つを満たしたとき）
   - **Cold cache**: 前回のリクエスト開始から TTL を超えた（ユーザーの離席、長いビルド待ちなど）。再書き込みはどのみち避けられないので、追加コストはほぼ 0。
   - **損益分岐の超過**: 予測残りターン数 × 削減量 × r ＞ 後続 × (w−r)。残りターン数はタスクの進捗から推定する。
   - **品質の閾値**: context 長がモデルの劣化域（経験的に window の一定割合）に近づいた。
   - **compaction と同時**: compaction は全体を書き直すイベントなので、tombstone も同時に適用する。
4. **Compaction の内容**: LLM 要約だけに頼らず、**逐語的な要素と構造化された状態**を中心にする。
   - タスクの目的と制約（ユーザー発言の原文の抜粋）
   - artifact trail（読んだファイルとその outline／handle、編集の diff 要約、テスト結果）
   - 決定事項・却下した案とその理由（同じ探索を繰り返さないため）
   - 未解決の todo
   - ルールや規約は要約に含めず、L1 の永続ファイルから再読み込みする
5. **Anthropic 固有の考慮**: 新しいモデルでは履歴の編集が thinking block を無効にする。編集はなるべく上記の一括適用にまとめ、それ以外は append-only を守る。server-side の context editing／compaction を使う場合は、その挙動をコストモデルに組み込む。

### 3.6 プロバイダーごとの方針

harness は次のパラメータをプロバイダー・モデルごとに持ち、方針を切り替える。

| パラメータ | 例 |
|---|---|
| `read_ratio` (r/p_in) | Opus 5.5: 0.05、DeepSeek: 約 0.02 |
| `write_premium` (w/p_in) | Anthropic: 1.25（5m）／2（1h）、DeepSeek: 1.0 |
| `ttl` | 5m／1h／best-effort |
| `explicit_breakpoints` | Anthropic: 最大 4、その他: 自動 |
| `min_cacheable` | 512〜4096 |
| `history_edit_penalty` | thinking が無効になるか |

- **DeepSeek 系**（write 割増なし、read が極端に安い）: ほぼ完全な append-only。削除は cold cache のときか compaction のときだけ。
- **Anthropic**: 上記に加えて、TTL を選ぶ（ターン間隔が 5 分未満なら 5m、5〜60 分なら 1h。Fable 系では max_tokens:0 での keep-alive のほうが安い場合がある）。breakpoint を配置する。新しい API（mid-conversation system、tool_addition、clear_at）を使う。Message Threads（beta）は単価は変わらないが、送信量と TTFT を下げられる（compaction とは併用できない）。
- **自動キャッシュ系（OpenAI／Gemini implicit）**: prefix の安定性に加え、提供されていればルーティングヒント（同じ session を同じ cache に載せるキーなど）を使う。

### 3.7 計測と回帰防止

| 指標 | 意味 | 目標と兆候 |
|---|---|---|
| `$/completed task` | 主指標 | ベンチマークで比較する |
| cache hit 率（入力トークン加重） | prefix の安定性 | 90% 未満なら prefix 破壊を調べる |
| `cache_creation` の急増 | 予期しない invalidation | 1 ターンで context 全体が write されていたら警告 |
| **再読込率** | prune／outline のやりすぎ | tombstone を付けた対象を再取得した割合。高ければ閾値を緩める |
| sub-agent のトークン倍率 | 委譲のコスト | 親単独と比べた倍率。上限を超えたら fresh／安いモデルへ |
| context ピーク／中央値 | 品質の代理指標 | 劣化域に入っていないか |
| output／input 比 | Code Mode の副作用 | コード生成が多すぎないか |

- **Prefix 破壊を検知する CI**: 固定シナリオで連続するリクエストの payload のバイト列を diff し、「末尾への追加以外の変更」が出たら失敗にする（Anthropic の cache diagnostics beta も使える）。
- **評価は 2 軸で行う**: SWE-bench 系の solve 率と $/task を、上記の各施策の ON／OFF で ablation する。JetBrains の研究や compaction 比較論文が示すとおり、凝った手法が単純な masking に勝つとは限らない。施策は計測で採否を決める。

---

## 4. 実装ロードマップ（案）

| フェーズ | 内容 | 狙い |
|---|---|---|
| P0 | 決定的シリアライズ、L0〜L3 のレイヤー化、usage と cache の計測、prefix diff CI | 安定して 90% 以上の hit 率を出す土台 |
| P1 | outline-first read（md／code／json／log）、大きな出力のファイル退避と明示的なプレビュー | 入口で絞る |
| P2 | TS Code Mode ランタイム（MCP→`.d.ts`、隔離、binding、承認ゲート、REPL handle）、ツールカタログの遅延ロード | 多数のツールを既定で使えるようにする |
| P3 | Prune scheduler（tombstone、cold cache での一括適用、損益分岐の判定）、構造化 compaction | 履歴を長期的に健全に保つ |
| P4 | Branch & Merge（cache-sharing fork／fresh sub-agent の自動選択、予算とガードレール） | 探索のゴミを残さない |
| P5 | プロバイダー別方針の自動調整、ablation ベンチマーク | コストと品質の最適点を探す |

---

## 5. 未解決の論点

- **品質と cache の衝突**: context rot は長さだけで決まるのか、ノイズの割合で決まるのか。append-only で長くなった context は、どの長さから品質を落とすのか（モデルごとに計測が必要）。
- **Manus の「観察にあえて変化を入れる」手法**（同じパターンの繰り返しを避ける）は、cache の安定性と正面から衝突する。採用するなら L3 だけに限る。
- **残りターン数 N の予測精度**: 損益分岐の判定は N の推定に依存する。タスク種別ごとの履歴から統計を取る必要がある。
- **Code Mode の安全性**: モデルが書いたコードが binding 経由で連鎖的に副作用を起こす。承認の粒度（呼び出しごとか、スクリプト全体か）の UX を設計する必要がある。
- **Cache-sharing fork の実現性**: プロバイダーによっては同じ prefix でも別のリクエスト系列で cache を共有できない場合がある（ルーティング、組織・ワークスペースの境界）。実測で確認する必要がある。

---

## 参考文献

ユーザーが提示した資料（※この環境からは直接取得できなかったため、関連する公開情報で補完した）
- Cloudflare, "Code Mode: the better way to use MCP" — https://blog.cloudflare.com/code-mode/
- OpenAI Developer Community, "Sub Agents are Fully Hydrating Parents Context" — https://community.openai.com/t/sub-agents-are-fully-hydrating-parents-context/1393050
- r/DeepSeek, cache hit rate のスレッド — https://www.reddit.com/r/DeepSeek/comments/1wri66b/can_anyone_explain_how_is_the_cache_hit_rate_at/

Code Mode・ツール
- Cloudflare, "Code Mode: give agents an entire API in 1,000 tokens" — https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare Docs, Codemode — https://developers.cloudflare.com/agents/model-context-protocol/codemode/
- InfoQ, Cloudflare Code Mode MCP Server — https://infoq.com/news/2026/04/cloudflare-code-mode-mcp-server
- Anthropic, "Code execution with MCP" — https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Advanced tool use"（Tool Search／PTC） — https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic Docs, Tool search tool — https://platform.claude.com/docs/agents-and-tools/tool-use/tool-search-tool
- AIMultiple, Code execution with MCP（独立検証） — https://research.aimultiple.com/code-execution-with-mcp
- Cursor, "Dynamic context discovery" — https://cursor.com/blog/dynamic-context-discovery

Context 管理・圧縮
- Anthropic, "Managing context on the Claude Developer Platform" — https://www.anthropic.com/news/context-management
- Anthropic Cookbook, Context engineering tools — https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- JetBrains Research, "The Complexity Trap" — https://arxiv.org/abs/2508.21433 ／ https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- Factory.ai, Evaluating compression — https://factory.ai/news/evaluating-compression
- Morph, Compaction vs Summarization — https://www.morphllm.com/compaction-vs-summarization
- D. Vaughan, Context Compaction Showdown — https://codex.danielvaughan.com/2026/04/10/context-compaction-showdown-coding-agents/
- Manus, "Context Engineering for AI Agents: Lessons from Building Manus" — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- "Harness Engineering: ... A Source-Code Study of Eleven Systems" — https://arxiv.org/pdf/2609.00006
- Aider repo map（解説） — https://www.agentpatterns.ai/context-engineering/repository-map-pattern/
- Claude Code の MCP 出力上限（解説） — https://fast.io/resources/mcp-token-limit/

Cache-first／DeepSeek
- Pi + DeepSeek 99.93% — https://www.dshbase.com/blog/pi-deepseek-cache/ ／ https://www.besthub.dev/articles/how-pi-s-harness-achieves-a-99-93-cache-hit-rate-for-deepseek-and-cuts-cost-up-to-7-17ca5d38bf04
- Reasonix — https://dev.to/esengine/how-a-deepseek-only-agent-framework-hit-85-prefix-cache-rate-and-saved-93-vs-claude-5c9g ／ https://news.ycombinator.com/item?id=48256953
- Hermes Agent, Append-Only Coding の提案 — https://github.com/NousResearch/hermes-agent/issues/66127
- DeepSeek prefix caching for coding agents — https://0to1.software/blog/deepseek-prefix-caching-for-coding-agents

Sub-agent
- openai/codex #12431 — https://github.com/openai/codex/issues/12431
- openai/codex #20077 — https://github.com/openai/codex/issues/20077
- openai/codex #53752 — https://github.com/openai/codex/issues/53752
- ccusage #897（fork の二重計上） — https://github.com/ccusage/ccusage/issues/897
- D. Vaughan, Sub-Agent Model Routing in Multi-Agent V2 — https://codex.danielvaughan.com/2026/07/24/codex-cli-sub-agent-model-routing-multi-agent-v2-hidden-schema-cost-control-configuration/
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system

価格・キャッシュ仕様
- Anthropic の prompt caching／価格（公式ドキュメント。2026-11 時点の値） — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Prompt caching across providers（二次情報） — https://www.developersdigest.tech/blog/prompt-caching-across-ai-providers-2026
