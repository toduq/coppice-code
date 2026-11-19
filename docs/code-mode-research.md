# Code Mode Research — 各 agent は LLM に何を見せているか

調査日: 2026-11-19
関連: [context-research.md](./context-research.md) §3.2

## 0. 要約（TL;DR）

- 調べた実装は 9 つある。そのうち 7 つ（Cloudflare、Codex、pctx、pi-codemode、UTCP、mcp-use、smolagents）は**配布パッケージや公開リポジトリのソースから、プロンプトと型生成の処理を直接読んだ**。Anthropic PTC は公式ドキュメント、Goose は二次情報に基づく。
- LLM に見せる内容は、どの実装も次の 4 点の組み合わせでできている。
  1. **公開ツール**: 「コードを実行するツール」1 つ（`code`／`exec`／`execute_tools` など）。これに発見用のツール（`search`／`list_functions`／`get_function_details`）が付くこともある。
  2. **API の型表現**: TypeScript の `declare const <ns>: { fn(input: XInput): Promise<XOutput> }` 形式が主流。説明文は JSDoc か `//` コメントで添える。Python 系（smolagents、mcp-use）は `def f(a: str) -> dict: """doc"""` 形式。
  3. **コードの形の規約**: async arrow function（Cloudflare）、`async function run()`（pctx）、モジュール本体＋トップレベル await（Codex、pi）、Python のコードブロック（smolagents）。
  4. **結果の契約**: 「`return` した値と log だけが context に戻る」。そのうえで切り詰め上限を設ける（Cloudflare は約 6k トークン、Codex は 10k トークン、pi は 50KB／2000 行）。
- 大きな分かれ目は **「型をすべてツール説明に埋め込むか、必要に応じて発見させるか」**。
  - 型をすべて埋め込む方式（Cloudflare の `createCodeTool`、Codex の code-mode-only、UTCP の `__interfaces`、smolagents）は単純で、cache も安定する。ただしツール数に比例して固定 context が膨らむ。
  - 発見させる方式（Cloudflare の runtime の `codemode.search/describe`、pctx の catalog／filesystem モード、pi の `describe_tools`、mcp-use の `search_tools`、Codex の `tools.tool_search`）は固定 context が小さい。そのかわり発見のための往復が増える。
  - 最新の実装（Cloudflare runtime、Codex、pi）は、**「発見処理をサンドボックスの中で行い、結果をコード内で受け取る」**方向に収束しつつある。
- 細かい工夫で効くもの:
  - 実行前の型チェック（pctx の sidecar モード、pi）
  - 出力型を `unknown` にせず、`CallToolResult<T>` や「JSON.parse 済みのオブジェクトが返る」と明示する（pctx、Codex、Anthropic）
  - プロパティを決定的な順序に並べる（Codex は**キーをソート**。prompt cache に効く）
  - 文字列を別パラメータで渡し、エスケープを不要にする（pi の `π`）
  - 並列実行（`Promise.all`）と「1 回の実行にまとめる」ことを明示的に指示する（pctx、pi）
  - 状態の持ち越し方を明示する（Codex の `store/load`、smolagents の「状態は持ち越される」、pctx の「持ち越されない」）

---

## 1. 調査方法と対象

| 実装 | 種別 | 確認した版・資料 | 確認方法 |
|---|---|---|---|
| Cloudflare `@cloudflare/codemode` | ライブラリ（TS、Workers） | 0.5.6 | npm tarball の `dist/` |
| OpenAI Codex Code Mode | coding agent 本体（Rust） | `main` ブランチ（2026-11） | `codex-rs/code-mode-protocol/src/description.rs` ほか（GitHub raw） |
| Anthropic Programmatic Tool Calling | API 機能 | 公式ドキュメント | platform.claude.com |
| Anthropic "Code execution with MCP" | 設計記事 | ブログ | 記事の内容（本文は取得できず、既知の内容と二次情報） |
| pctx（Port of Context） | ゲートウェイ（Rust／Deno） | `pctx_code_mode` 0.5.0 | crates.io crate の `descriptions/*.txt` |
| pi-codemode（Pi 拡張） | coding agent 拡張（TS） | `@georgebashi/pi-codemode` 0.1.0 | npm tarball の `src/` |
| UTCP `@utcp/code-mode` | ライブラリ（TS、isolated-vm） | 1.2.13 | npm tarball |
| mcp-use | ライブラリ（Python） | 1.7.1 | wheel |
| smolagents `CodeAgent` | フレームワーク（Python、CodeAct 系） | 1.26.0 | wheel の `prompts/code_agent.yaml` |
| Goose Code Mode | coding agent（Rust） | v1.17.0 以降 | 二次情報のみ（ドキュメントのサイトはこの環境から到達できず） |

> 引用はすべて各 OSS のソースからの抜粋（ライセンスはそれぞれ MIT／Apache-2.0）。長いものは省略している。

---

## 2. 実装ごとの詳細

### 2.1 Cloudflare `@cloudflare/codemode`（0.5.6）

Cloudflare には 3 つの使い方がある。

#### (a) `createCodeTool`（AI SDK 向け）／`codeMcpServer`（MCP サーバーをラップ）

- **公開ツール**: `codemode`（AI SDK）または `code`（MCP）の 1 つだけ。入力は `{ code: string }`（説明は "JavaScript async arrow function to execute"）。
- **ツール説明のテンプレート**（`{{types}}` と `{{example}}` を置換する）:

```text
Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

{{example}}
```

  `{{example}}` は最初の MCP ツールのスキーマから自動生成される。例: `Example: async () => { const r = await codemode.searchWeb({ query: "..." }); return r; }`
- **型表現**（`generateTypes`）: 入力型と出力型を `type XInput = {...}` として先に並べ、続けて名前空間を **`declare const`** で宣言する。説明文と各パラメータの説明は JSDoc の `@param input.<field>` で書く。

```ts
type SearchWebInput = { query: string; limit?: number }
type SearchWebOutput = unknown        // outputSchema が無ければ unknown

declare const codemode: {
	/**
	 * Search the web
	 * @param input.query - search terms
	 */
	searchWeb: (input: SearchWebInput) => Promise<SearchWebOutput>;
}
```

- **ポイント**:
  - 型は TypeScript で見せるが、**書かせるのは JavaScript**（型注釈は禁止）。実行側で型を剥がす処理が不要になる。
  - 名前空間はプロバイダーごとに分けられる（`codemode`、`db` など）。
  - `needsApproval` の付いたツールは型からも実行環境からも除外される（runtime では承認フローに回す）。
  - コードの正規化（`normalizeCode`）を acorn の AST で行う。コードフェンス、`export default`、名前付き関数、最後の式を、どれも async arrow function に変換する。**モデルの書き方の揺れをホスト側で吸収**している。
  - MCP の結果は unwrap する。優先順は `structuredContent` → 全部 text なら `JSON.parse` → それ以外はそのまま。`isError` は例外として投げる。
  - **応答サイズの上限は 24,000 文字（約 6k トークン）**。切り詰めは構造を保ったまま行う（大きい値から削り、JSON として壊さない）。削った箇所には `--- TRUNCATED ---` の目印と「Narrow the request to reduce response size.」を付ける。

#### (b) `openApiMcpServer`（2,500 以上の endpoint の Cloudflare API を約 1,000 トークンで公開する方式）

- **公開ツール**: `search` と `execute` の 2 つ。
- `search` の中では `codemode.spec()` が **$ref を解決済みの OpenAPI spec オブジェクト**を返す。モデルは spec を JS で絞り込んで endpoint を探す（例: `Object.keys(spec.paths)`、タグで絞る）。ツール説明に入れるのは、OpenAPI の構造の型（`OperationObject`、`PathItem`、`OpenApiSpec`）とコード例 2 つだけ。
- `execute` は `codemode.request({ method, path, query?, body?, contentType?, rawBody? })` を使う。冒頭で「First use 'search' to find the right endpoints.」と指示している。
- **認証情報はホスト側の `request` 関数**が持ち、サンドボックスには入れない。
- → **API 全体の型を生成せず、「spec そのものをデータとしてコードで検索させる」**という発想。endpoint が数千ある場合に有効。

#### (c) `createCodemodeRuntime`（Durable Object を使う、永続実行・承認付きの新しい方式）

- ツール説明は `buildDescription` で動的に組み立てる。要旨は次のとおり。

```text
Execute JavaScript in a sandbox with access to connector SDKs.
## Workflow
1. `const matches = await codemode.search("short intent phrase");`
2. `const docs = await codemode.describe(matches.results[0].path);`
3. Call the method: `await <connector>.<method>(args);`
## Rules
- The ONLY globals are `github`, `repo` and `codemode` (plus standard JavaScript). There is no `host`, `fs`, `require`, `process`, or Node.js API ...
- Never guess method names. If you have not used a connector in this conversation, run a discovery pass first ...
- `codemode.step(name, fn)` wraps side-effectful or nondeterministic work (raw fetch, random, time) so it runs once and is replayed on resume.
- Some methods require approval. The run pauses until the user approves, then resumes automatically. Write code as if the call returns normally.
- A result with `status: "paused"` means the run is awaiting human approval ... do NOT re-issue the code
- All code outside connector calls and `codemode.step` must be deterministic so resume can replay it.
## Snippets
- `codemode.run("name", input)` runs a saved snippet ...
## Available connectors
- `github` — <hint>
```

- **発見処理をサンドボックスの中で行う**: `codemode.search(query)` と `codemode.describe(target)` の結果は**実行中のコードに返る**。プロンプトには入らない。ドキュメントには「the model pays for exactly the type information it asks for」とある。search のスコアは path 12／method 10／connector 8／description 5 の重み付けで、上位 50 件まで。
- **承認と replay**: 副作用は `codemode.step` で境界を作り、tool call の log として記録する。承認待ちになったら中断し、承認後に**同じコードを replay**し、記録済みの結果を再利用して続きから実行する。`rollback` は各ツールの `revert` を使う。
- **Snippet**: 成功したスクリプトを再利用可能な部品として保存し、`search` の結果にも出す（Anthropic の記事にある「skills」に相当する）。

### 2.2 OpenAI Codex Code Mode（`exec`／`wait`）

coding agent 本体に組み込まれた実装として、最も作り込まれている。

- **公開ツール**:
  - `exec`: **freeform ツール**。入力は JSON ではなく生の JS ソースで、Lark 文法で制約する。
  - `wait`: 長時間実行される cell の続きを待つ。
  - freeform に対応しないプロバイダー向けに、`{code: string}` 型の function tool へのフォールバックが提案されている（issue #37825）。
- **freeform 文法**（JSON エスケープが不要。先頭行の pragma で実行パラメータを渡す）:

```lark
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE
PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
```

- **`exec` の説明テンプレート**（抜粋）:

```text
Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- `exit()` / `text(value)` / `image(...)` / `audio(...)` / `generatedImage(...)`
- `store(key, value)`: stores a serializable value under a string key for later `exec` calls in the same session.
- `load(key)`: returns the stored value ...
- `notify(value)`: immediately injects an extra `custom_tool_call_output` for the current `exec` call.
- `setTimeout` / `clearTimeout`
- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running.
```

- **出力の契約**: `console` は**無い**。出力は `text()`／`image()` で**明示的に積んだものだけ**になる。標準出力を全部返す方式ではなく、モデルが「何を context に入れるか」を明示的に選ぶ設計である。
- **ツール宣言の描画**（`render_code_mode_sample_for_definition`）: ツールごとに、見出し・説明・1 行の宣言の 3 つを並べる。

````text
### `mcp__sample__alpha_tool`
<tool description>

exec tool declaration:
```ts
declare const tools: { mcp__sample__alpha_tool(args: { city: string; }): Promise<CallToolResult<{ ok: boolean; }>>; };
```
````

  - 入力型は JSON Schema から TypeScript に変換する。**プロパティはキー名でソート**し、description は `// ...` の行コメントで付ける。
  - スキーマ 1 つあたりの上限は 16,000 bytes（`DEFAULT_INPUT_SCHEMA_MAX_BYTES`）で、超えたら `unknown` にする。再帰参照は 1 段だけ展開する。
  - MCP ツールの出力型は、`outputSchema` があれば `CallToolResult<structuredContent の型>`、なければ `CallToolResult`。
  - MCP の `CallToolResult`／`ContentBlock` などの共通型は、**「Shared MCP Types」の前置き**として 1 回だけ置く。
  - 名前空間（MCP サーバー）ごとに `## <namespace>` の見出しと説明を付ける。
- **遅延ロードされるツール**（deferred tools）: 説明に載らないツールは `ALL_TOOLS` に載る。BM25 検索は `await tools.tool_search({query, limit: 8})` で、結果は `{tools:[{name, description}]}`。説明には「Print results with `text()` and inspect unfamiliar declarations before calling ... in a later execution.」とあり、**発見と呼び出しを別の exec に分ける**ことを推奨している。
- **長時間の実行**: `yield_time_ms`（既定 10 秒）経過後に cell ID を返して中断し、`wait` で続きを受け取る（新しい出力だけが返る）。
- 既知の課題（issue）:
  - nested な `exec_command` の説明まで埋め込むので、exec の説明が約 17.5K 文字になる（#32101 の周辺）。
  - nested 呼び出しが rollout log に普通の function call として出ない。
  - 失敗時に、完了済みの nested 呼び出しの一覧を返す提案がある（#49908）。
- 前身として `js_repl`（Node ベースの永続カーネル）がある。`js_repl_tools_only` モードでは直接呼べるツールを `js_repl` に限定し、他のツールは `await codex.tool(...)` 経由で呼ぶ（二次情報）。

### 2.3 Anthropic

#### Programmatic Tool Calling（API 機能）

- `{"type": "code_execution_20260120", "name": "code_execution"}` を宣言し、カスタムツール側に `"allowed_callers": ["code_execution_20260120"]` を付ける。
- コードは **Python**。公式ドキュメントには「Tools that allow a code execution caller are exposed to Claude's code as async Python functions ... Each function takes a single dict of arguments and returns a string: the text of the `tool_result` you send back.」とある。例: `rows = json.loads(await query_database({"sql": "<sql>"}))`
  - → **戻り値は常に文字列**。構造は保証されないので、ツール説明に出力形式を書くことが重要になる。公式も「Provide detailed descriptions of your tool's output format in the tool description. If you specify that the tool returns JSON, Claude attempts to deserialize ...」と推奨している。
- JSON Schema から Python シグネチャへの変換規則は**公開されていない**（サーバー側で内部的に提示している）。
- コードからツールが呼ばれると、レスポンスに `tool_use`（`caller: {type, tool_id}` 付き）が返る。クライアントは `tool_result` だけを含む user メッセージで応答する。**これらの結果は Claude の context に入らない**。最終的な stdout などだけが入る。
- 制約: 1 回の呼び出しは約 4 分でタイムアウトする。`strict`、強制 `tool_choice`、MCP connector ツールとは併用できない。

#### "Code execution with MCP"（設計記事）

- MCP サーバーを**ファイルツリーとして見せる**。例: `servers/google-drive/getDocument.ts`。各ファイルに入出力の interface と、`callMCPTool('google_drive__get_document', input)` を呼ぶ薄いラッパー関数を置く。モデルは `ls` や read で必要なファイルだけを読む。
- 加えて、`search_tools` に detail level（名前だけ／説明つき／全スキーマ）を持たせる案、中間データをサンドボックスの中で処理する案、状態をファイルに書き出す案、**再利用できるコードを `skills/` に保存する**案が示されている。
- → pctx の filesystem モード、Cloudflare の snippets、mcp-use の `detail_level` は、いずれもこの記事の具体化と言える。

### 2.4 pctx（`pctx_code_mode` 0.5.0）

**ツールの開示方式を 3 種類から選べる**ので、比較対象として優れている。説明文はバージョン管理されたテキストファイル（`descriptions/tools/*/v1.txt`）に置かれ、Rust 版と Python 版で共用している。

| モード | 公開ツール | 型の見せ方 |
|---|---|---|
| **Catalog** | `list_functions`、`get_function_details`、（`search_functions`）、`execute_typescript` | 一覧では名前空間ごとのシグネチャ（型の詳細は省く）を返す。詳細は `Namespace.fn` を指定して完全な型を返す |
| **Filesystem** | `execute_bash`（読み取り専用の仮想 FS `/sdk/`）、`execute_typescript` | `/sdk/README.md`（全関数の一覧）と `/sdk/{Namespace}/{fn}.d.ts` を置き、`ls`／`cat`／`grep` で探させる |
| **Sidecar** | `execute_typescript` のみ（ツール一覧は通常の tool 定義側で見せる） | `invoke({name, arguments})` の 1 関数。`InvokeMap` 型でツールごとの引数と戻り値を型付けし、**厳密な型チェックを通らないと実行しない** |

共通のワークフロー指示（`workflows/common.txt`）:

```text
- BATCH MULTIPLE TOOL CALLS INTO ONE `execute_typescript` CALL.
- These tools exists to reduce round-trips. When a task requires multiple tool calls:
    - WRONG: Multiple `execute_typescript` calls, each with one tool
    - RIGHT: One `execute_typescript` call with a script that calls all needed tools
- Only `return` and `console.log` data you need, tools could have very large responses.
- IMPORTANT: All tool calls are ASYNC. Use await for each call.
```

`execute_typescript`（catalog）の説明（抜粋）:

```text
CODE STRUCTURE:
async function run() {
    // Call Namespace.functionName() with proper types
    return result;
}
IMPORTANT RULES:
- You MUST define a `run()` function
- You MUST NOT call or export any functions from the root of the script, `run()` will be called automatically
- Functions MUST be called as 'Namespace.functionName'
- Only registered SDK functions are available - no fetch(), fs, or other Node/Deno APIs
- Variables don't persist between executions
TOKEN USAGE WARNING:
- Filter/map/reduce data IN YOUR CODE before returning
RETURN TYPE NOTE:
- Function results are already parsed JavaScript objects, NOT JSON strings
- Do NOT call JSON.parse() on results
```

- sidecar モードには、さらに「The typescript environment has STRICT typing ... if a `string` property is not listed as required by the json schema you must handle the case when it is undefined」「AVOID adding comments to the code」（出力トークンの節約）がある。
- `get_function_details` の説明には「Functions showing Promise<any> return type have no schema - the actual runtime value is a parsed JavaScript object (never a JSON string).」とある。**出力スキーマが無いときの扱いを明言**している。
- 結果は Markdown で返す。`Code Executed Successfully: true` の後に `# Return Value`（JSON）、`# STDOUT`、`# STDERR` が続く。
- 実行環境は Deno のサンドボックス。

### 2.5 pi-codemode（Pi の coding agent 拡張、0.1.0）

**coding agent の組み込みツール（read／write／edit／shell）まで code mode に寄せた**例。Pi の個別ツールを `execute_tools` の 1 つに置き換える。

- **公開ツール**: `execute_tools`。パラメータは次の 2 つ。
  - `code`: TypeScript の本体
  - `strings?: Record<string,string>`: コード内で `π.keyName` として参照できる文字列定数。**ファイル内容など、JS の中でクォートしにくいテキストをエスケープ不要で渡す**ための仕組み。
- **型の見せ方**:
  - 組み込みツールの型宣言（約 400 トークン）は system prompt に入れる。
  - MCP ツールは**名前空間名とツール数だけ**を載せる。詳細は `tools.describe_tools({namespace, tool?})` と `tools.search_tools({query})` で発見させる。
  - 完全な MCP の型は**型チェッカーの中にだけ**持たせる（モデルには見せない）。
- 組み込みの型宣言（抜粋）:

```ts
declare const tools: BuiltinTools & McpServerNamespaces;
interface BuiltinTools {
  /** Read a file and return its content as a string. ... Default limit: 2000 lines or 50KB. */
  read(params: { /** Path ... */ path: string; offset?: number; limit?: number }): Promise<string>;
  write(params: { path: string; content: string }): Promise<void>;
  /** ... Throws if text not found or ambiguous. */
  edit(params: { path: string; oldText: string; newText: string }): Promise<string>;
  search_tools(params: { query: string }): Promise<string>;
  describe_tools(params: { namespace: string; tool?: string }): Promise<string>;
  progress(message: string): void;
}
declare function print(...args: any[]): void;
declare const $: typeof Shell;      // zx（シェル。引数は自動でエスケープ）
declare const fs: typeof import('fs-extra'); // 他に path, os, glob, retry, sleep, YAML ...
declare const π: Readonly<Record<string, string>>;
```

- **実行前の型チェック**: 「Your code is type-checked against the tool API before execution. Type errors are returned for correction — no side effects occur until types are valid.」。TypeScript compiler の診断（行・列・メッセージ）を返す。
- **system prompt の大半はパターン集**: 並列（`Promise.all`）、連鎖、発見してから fan-out、try/catch、`Promise.allSettled` の 5 つのコード例。最後に「Parallelize independent calls」「Chain dependent calls」と念押しする。
- 出力: `print()` と `return` の両方を返す。シェル出力は末尾側を残して切り詰め（2000 行／50KB）、全文は一時ファイルに書き出してパスを示す。
- 任意の npm パッケージ（`simple-git`、`octokit` など）を、型付きのグローバルとしてサンドボックスに追加できる。

### 2.6 UTCP `@utcp/code-mode`（1.2.13）

- 実行は `callToolChain(code, timeout=30000, memoryLimit=128)` で、isolated-vm を使う。返り値は `{ result, logs }`（console の出力はすべて保存される）。
- **ツール呼び出しは同期的な見た目にする**: 「Tool calls are synchronous from your perspective (no await needed) - the host bridges async work transparently.」。`await` を付けても動く。
- 型は `namespace manual { interface toolInput {...} interface toolOutput {...} }` 形式。JSDoc には `Tags:` と **`Access as: manual.tool(args)`** を入れて、呼び方を明示する。
- サンドボックスの中で `__interfaces`（全定義の文字列）と `__getToolInterface('manual.tool')` を参照できる（発見処理をコード内で行う）。
- `AGENT_PROMPT_TEMPLATE` という、system prompt に入れる約 40 行の利用ガイドを提供している。Discovery → Interface Introspection → Code Execution → Best Practices の構成で、「Discover first, code second」を強調する。

### 2.7 mcp-use（Python、1.7.1）

- **公開ツール**: `execute_code(code, timeout=30)` と `search_tools(query, detail_level)`（`detail_level` は `names`／`descriptions`／`full`。Anthropic の記事の案をそのまま実装したもの）。
- サンドボックスの中では `await github.get_pull_request(owner=..., ...)` のように、**サーバー名を名前空間にした async 関数**として呼ぶ。`__tool_namespaces` と `search_tools()` もコード内で使える。
- system prompt 用に `CODE_MODE_AGENT_PROMPT`（約 120 行）がある。主な節は次のとおり。
  - Tool Discovery
  - Calling Tools
  - Data Processing（「Process data efficiently in the execution environment before returning results」と、要約だけを return する例）
  - Best Practices（Progressive Discovery／Minimize Context／try-except／print／await）
  - Available Builtins（使える builtins の一覧。File I/O・import・eval は禁止）
- 結果は `{"result", "logs", "error", "execution_time"}` の JSON。

### 2.8 smolagents `CodeAgent`（1.26.0、CodeAct の系譜）

- ツール呼び出しを専用 API で行うのではなく、**応答の本文に書かれたコードブロックを実行する**方式（Thought → Code → Observation のループ）。
- 型は Python の関数シグネチャと docstring で見せる（`Tool.to_code_prompt`）。

```python
def web_search(query: string) -> string:
    """Performs a web search ...

    Args:
        query: The search query
    """
```

  出力スキーマを持つツールは `-> dict` とし、次の注記と JSON Schema の全文を docstring に入れる: "Important: This tool returns structured output! Use the JSON schema below to directly access fields like result['field_name']. NO print() statements needed to inspect the output!"
- ルールの例:
  - 「出力スキーマが無いツールは同じブロックで連鎖させず、print して次のステップで使え」
  - 「スキーマが有れば安心して連鎖してよい」
  - 「The state persists between code executions」
  - 「import は {{authorized_imports}} のみ」
  - 「ツール名と同じ変数名を使うな」
  - 「同じ引数で同じツールを再度呼ぶな」
- → **出力型が分かるかどうかで、連鎖してよい範囲を変える**という指示は、他の実装にはない実践的な知見である。

### 2.9 Goose（参考、二次情報）

- v1.17.0 で Code Mode を platform extension として導入した。他の extension を JS／TS モジュールとして包み、80 個のツールを 3 つ（`list_functions`、`get_function_details`、`execute_typescript`）に見せる。これは pctx の catalog モードと同じ構成である。初期のブログでは `read_module`／`execute_code` という名前で紹介されていた。
- 同じタスクでトークンが 30% 減ったという社内計測がある。

---

## 3. 比較表

| 実装 | 公開ツール数 | 言語（書かせる） | 型の位置 | 型の形式 | 発見手段 | コードの形 | 結果の返し方 | 状態の持ち越し | 実行前検査 | 承認 |
|---|---|---|---|---|---|---|---|---|---|---|
| Cloudflare createCodeTool | 1 | JS（TS 禁止） | ツール説明に全部 | `type`＋`declare const ns`＋JSDoc | なし | async arrow（AST で正規化） | return 値。約 6k トークンで構造的に切り詰め | なし | なし | 承認が必要なツールは除外 |
| Cloudflare openApi | 2 | JS | spec をデータとして渡す | OpenAPI の構造型 | `search` の中で spec を JS で検索 | async arrow | 同上 | なし | なし | ホスト側の request 関数 |
| Cloudflare runtime | 1（＋search／execute） | JS | サンドボックス内で要求に応じて | describe() が TS の型を返す | `codemode.search/describe`（サンドボックス内） | async arrow | 同上（`paused` 状態もある） | snippet、step の replay | なし | **永続的な承認と replay、rollback** |
| Codex | 2（exec／wait） | JS（freeform） | ツール説明（code-mode-only）＋deferred | `declare const tools: {fn(args:{…}):Promise<CallToolResult<T>>}`、プロパティはソート、`//` コメント | `ALL_TOOLS`、`tools.tool_search` | モジュール本体、トップレベル await、pragma | **`text()` などで明示的に積んだものだけ**、10k トークン | `store/load` | なし | 通常のツール承認経路 |
| Anthropic PTC | 1＋カスタム | Python | サーバー側（非公開） | 非公開（async 関数、dict を渡して str が返る） | Tool Search と併用 | Python のスクリプト | stdout など | container を再利用 | なし | クライアントが tool_result を返す |
| pctx catalog | 3〜4 | TS | 発見ツールの結果 | namespace の宣言 | list → details（→ search） | `async function run()` | Markdown（Return／STDOUT／STDERR） | なし | （sidecar のみ厳密な型検査） | — |
| pctx filesystem | 2 | TS | 仮想 FS 上の `.d.ts` | ファイル単位の宣言 | bash（ls／cat／grep） | 同上 | 同上 | なし | — | — |
| pi-codemode | 1 | **TS** | 組み込みは system prompt、MCP は発見 | `interface`＋JSDoc | `describe_tools`、`search_tools`（サンドボックス内） | 本体、トップレベル await | print＋return、50KB の末尾側を残す | — | **tsc で型検査** | — |
| UTCP | 1（関数） | TS | サンドボックス内の `__interfaces` | `namespace{interface}`＋`Access as:` | `__getToolInterface` | async 関数本体（同期的な見た目） | `{result, logs}` | なし | なし | — |
| mcp-use | 2 | Python | `search_tools` の結果 | dict（name／description／schema） | `search_tools(detail_level)` | async 本体 | `{result, logs, error, time}` | なし | なし | — |
| smolagents | 0（本文中のコード） | Python | system prompt に全部 | `def f(x: type) -> type: """doc"""` | なし | コードブロック | print した内容が Observation になる | **あり** | なし | — |

---

## 4. 設計上の論点

### 4.1 型の開示方式：「全部を埋め込む」か「発見させる」か

| 方式 | 固定 context | 往復回数 | cache | 向いている規模 |
|---|---|---|---|---|
| ツール説明に全部埋め込む | ツール数に比例して増える | 最小（1 回） | ◎（静的なので prefix が安定する） | 〜数十ツール |
| 一覧だけ見せて、詳細は発見させる | 小さい | +1〜2 回 | ○（発見結果は末尾に append される） | 数十〜数百 |
| データとして検索させる（OpenAPI spec） | 最小 | +1 回 | ◎ | 数千 endpoint |
| サンドボックス内で発見させる（describe がコードに返る） | 最小 | 0〜1 回（同じ実行内で発見と呼び出しを済ませられる） | ◎ | 規模を問わない |

- **サンドボックス内で発見させる場合の注意**: 発見と呼び出しを 1 つのスクリプトにまとめると、モデルは型を「見ないまま」引数を組むことになり、失敗しやすい。Codex は「inspect unfamiliar declarations before calling ... in a later execution」として、**発見の exec と呼び出しの exec を分ける**ことを推奨している。pi は**型チェッカーで補っている**（型を見ていなくても、誤りがあれば実行前に返す）。
- 一度使ったツールの型は、すでに履歴（cache 済みの prefix）に入っている。2 回目以降は発見を省略できる。Cloudflare の「If you have not used a connector in this conversation, run a discovery pass first」はこの考え方に基づく。

### 4.2 型表現の細部

- **TypeScript の `declare const ns: {...}` 形式が事実上の標準**。interface を別に定義する方式（UTCP、pi）より、1 行のインライン型（Codex）のほうがトークンは少ない。
- **出力型**は品質への影響が大きい。
  - 出力型が `unknown` の場合: smolagents は「連鎖させず print して確認せよ」と指示する。pctx は「JSON.parse するな。パース済みのオブジェクトだ」と明示する。
  - MCP の場合: Codex は `CallToolResult<T>` と共通型の前置きを入れ、`structuredContent` を型付けする。Cloudflare はホスト側で unwrap して値そのものを返す（モデルが `.content[0].text` を辿る必要がない）。
  - Anthropic PTC では戻り値が常に str。**ツール説明に出力形式を書くことが必須**になる。
- **パラメータの説明**は JSDoc の `@param input.x`（Cloudflare）、プロパティ単位の `/** */`（UTCP、pi）、`//` 行コメント（Codex）のどれか。
- **決定的に描画する**: Codex はプロパティをソートし、スキーマ 1 つあたりの bytes に上限を設け、再帰の展開を 1 段に限る。prompt cache の安定性と、上限を超えないことの両方を担保している。
- **識別子の正規化**: `mcp__server__tool` のような名前を JS の識別子に変換する（Codex、Cloudflare の `sanitizeToolName`）。変換前の名前が変換後と違う場合は見出しに併記する（`### \`norm\` (\`raw\`)`）。

### 4.3 コードの形と入力の渡し方

- **freeform（生のソース）か JSON の `{code}` か**: JSON に入れるとコード中の改行や引用符がすべてエスケープされ、トークンが増え、誤りの原因にもなる。対策は次の 3 つ。
  - Codex: freeform ＋ Lark 文法
  - pi: `strings` パラメータ（`π.key`）で長い文字列を別に渡す
  - Cloudflare: コードフェンスなどを AST で正規化する
- **エントリーポイントの規約**: arrow function、`run()`、モジュール本体のどれでも動く。重要なのは「規約を明示すること」と「ホスト側で揺れを吸収すること」。
- **TypeScript で書かせるか JS で書かせるか**: TS で書かせる（pi、pctx）なら実行前の型検査ができる。JS で書かせる（Cloudflare、Codex）なら実行が速くて単純で、型注釈ぶんの出力トークンも要らない。

### 4.4 出力の契約（context に入れるもの）

- 「`return`＋`console.log`」がいちばん一般的。Codex は**`text()` などで明示的に積んだものだけ**を返し、console は無い。不用意な log で context が膨らむのを防ぐ、最も厳格な方式である。
- 上限と切り詰め方:
  - Cloudflare: 6k トークン。構造を保ったまま切り詰める（JSON を壊さない）
  - Codex: 10k トークン（pragma で変更可）
  - pi: 末尾側を残し、全文はファイルに退避
  - いずれも**「切り詰めたこと」を明示し、絞り込み方を案内する**
- 長時間の実行: Codex の `yield_time_ms` と `wait` による段階的な出力、pi の `tools.progress()`（UI に流すだけで context には入れない）。

### 4.5 状態の持ち越し・再利用・承認

- 状態の持ち越しについては、どれもモデルに**明示**している。持ち越さない（pctx、Cloudflare）、key-value のみ（Codex の `store/load`）、REPL 全体（smolagents、旧 `js_repl`）のいずれか。大きなデータは handle として持ち越すと context に戻さずに済む（[context-research.md](./context-research.md) §3.2 の REPL handle）。
- 再利用: Cloudflare の snippets、Anthropic の記事の `skills/`。**成功したスクリプトを部品として保存する**ことで、次回は「探索して組み立てる」コストが不要になる。
- 承認: code mode では harness が個々の呼び出しを事前に見られない。対策は 3 通りある。
  - (a) 承認が必要なツールを code mode から除外する（Cloudflare の createCodeTool）
  - (b) 呼び出し時点で中断し、承認後に replay する（Cloudflare runtime）
  - (c) nested 呼び出しを通常のツール実行経路に戻して、既存の承認を適用する（Codex）

---

## 5. coppice-code への適用案

### 5.1 公開するツール

```
run_code      — freeform（対応するプロバイダーのみ）または {code, strings?}。TS を受け付け、実行前に型検査する
run_code_wait — 長時間実行される cell の続きを受け取る（Codex の wait 相当）
```

**発見処理は run_code の中で行う**（`sdk.search`／`sdk.describe`）。これにより、ツールを増やしても top-level の tool 定義（= L0 prefix）は変わらない。

### 5.2 run_code の説明に入れるもの（案）

````text
Run TypeScript to orchestrate tool calls. Only what you emit with `out()` (or `return`) is shown to you.

- Globals: `tools` (built-in: read/edit/search/bash), MCP namespaces (`github`, `slack`, ...), `sdk`, `π`, `store/load`.
- Discover before calling an unfamiliar API:
    const hits = await sdk.search("pull request comments");      // [{path, summary}]
    out(await sdk.describe(hits[0].path));                      // TS declaration
  Call it in the NEXT run unless you already know its type. Type errors are returned before anything executes.
- Batch: do all independent calls in ONE run with Promise.all; filter/aggregate in code; out() only what you need.
- Results are parsed values (never JSON strings). MCP results are unwrapped to structuredContent when present.
- Side-effecting calls (marked `@approval`) pause until the user approves; write code as if they return normally.
- Long text (file contents, patches): pass via the `strings` parameter and reference as `π.name`.
- Output budget: 4k tokens by default (`// @run: {"max_output_tokens": N}` to change). Oversized values are truncated structurally and the full value is saved to a file whose path is shown.
- Values persist only via `store(key, v)` / `load(key)`; large data should be kept there, not printed.

Built-in API:
```ts
declare const tools: {
  read(args: { path: string; section?: string; range?: [number, number] }): Promise<ReadResult>; // outline for large files
  ...
};
```
Namespaces: github (42 tools), slack (18 tools), ...   // 名前と件数だけ
````

設計上の根拠:
- **組み込みツールの型と、名前空間の一覧（名前と件数）だけを固定で載せる**（pi 方式）。MCP の詳細は発見させる（Cloudflare runtime 方式）。
- 出力は明示的に積んだものだけにする（Codex 方式）。上限を設け、切り詰めは構造を保ったまま行う（Cloudflare 方式）。超えた分はファイルに退避する（pi 方式）。
- 発見と呼び出しは原則として別の実行に分け、型検査でその安全性を補う（Codex と pi の組み合わせ）。
- 承認は呼び出し時点で中断し、承認後に replay する（Cloudflare runtime 方式）。

### 5.3 型描画の規則

1. `declare const <ns>: { <fn>(args: {...}): Promise<Out>; }` の 1 行形式にする（Codex）。説明は 1 行の JSDoc にまとめる。
2. プロパティを**キー名でソート**する。スキーマ 1 つあたりの上限は 4〜16KB とし、超えたら `unknown`。再帰の展開は 1 段まで。描画結果をキャッシュし、**同じ入力からは必ず同じバイト列**になるようにする（prompt cache 対策）。
3. 出力型: `outputSchema` があればそれを使う。無ければ `unknown` ではなく **`Promise<Json /* unstructured */>`** とし、説明に出力形式を書くよう MCP 設定側にも推奨する（Anthropic／smolagents の知見）。
4. 識別子を正規化し、変換前の名前が違う場合は併記する。
5. MCP の共通型（`ContentBlock` など）は**定義せずに済ませる**。ホスト側で unwrap する（Cloudflare 方式）。

### 5.4 評価で確認すべきこと

- 型を全部埋め込む／一覧だけ／サンドボックス内で発見、の 3 方式の比較: $/task、往復回数、失敗率（引数の誤り）
- JS と TS（型検査あり）の比較: 出力トークンと再試行の回数
- freeform と JSON `{code}` の比較: 出力トークンとエスケープ起因のエラー
- 出力上限（2k／4k／10k）ごとの再実行率（絞り込みのための再実行が増えていないか）

---

## 6. 未確認事項・制約

- Anthropic PTC がサーバー側でツールを Python シグネチャに変換する規則は公開されていない。
- Codex の `exec` の実際の説明全文はツール構成によって変わる（nested ツールの説明が埋め込まれる）。本文中の抜粋はテンプレート部分だけ。
- Goose のドキュメントサイト（goose-docs.ai）と Anthropic・Cloudflare のブログ本文はこの環境から取得できなかった。該当箇所は検索結果の要約と既知の内容に基づく。
- 各ライブラリは更新が速い。数値（上限、既定値）は確認時点の版のもの。

---

## 参考文献

一次資料（ソース）
- Cloudflare `@cloudflare/codemode` 0.5.6 — https://www.npmjs.com/package/@cloudflare/codemode ／ https://github.com/cloudflare/agents/tree/main/packages/codemode
- OpenAI Codex `codex-rs/code-mode-protocol/src/description.rs`、`json_schema_types.rs`、`codex-rs/core/src/tools/code_mode/*.rs` — https://github.com/openai/codex
- pctx `pctx_code_mode` 0.5.0 — https://docs.rs/crate/pctx_code_mode/0.5.0 ／ https://pctx.readthedocs.io/
- pi-codemode 0.1.0 — https://www.npmjs.com/package/@georgebashi/pi-codemode
- UTCP `@utcp/code-mode` 1.2.13 — https://www.npmjs.com/package/@utcp/code-mode
- mcp-use 1.7.1 — https://pypi.org/project/mcp-use/
- smolagents 1.26.0 — https://pypi.org/project/smolagents/

ドキュメント・記事
- Anthropic, Programmatic tool calling — https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- Anthropic, Code execution with MCP — https://www.anthropic.com/engineering/code-execution-with-mcp
- Cloudflare, Code Mode — https://blog.cloudflare.com/code-mode/ ／ https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare Docs, Codemode — https://developers.cloudflare.com/agents/api-reference/codemode
- Codex issues: #32101 https://github.com/openai/codex/issues/32101 ／ #37825 https://github.com/openai/codex/issues/37825 ／ #49908 https://github.com/openai/codex/issues/49908
- DeepWiki, Codex Code Mode and JavaScript REPL — https://deepwiki.com/openai/codex/5.8-code-mode-and-javascript-repl
- D. Vaughan, Codex CLI JavaScript REPL — https://codex.danielvaughan.com/2026/04/08/codex-cli-javascript-repl-stateful-scripting/
- Goose, Code Mode — https://goose-docs.ai/docs/guides/managing-tools/code-mode ／ https://dev.to/goose_oss/8-things-you-didnt-know-about-code-mode-4h71
- pctx の紹介 — https://portofcontext.com/blog/introducing-pctx-unified-code-mode-mcp-server
