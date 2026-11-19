# AGENTS.md

- コミュニケーションは簡潔に行う。
- コードコメントは残さない。
- 未リリースのため互換性は考慮せず、常にコードをシンプルに保つ。
- 既存のコードやドキュメントへの変更依頼は、その依頼内容も最初から存在した条件として考え直し、成果物をシンプルに保つ。
- 歴史的経緯はgitに任せ、コードやドキュメントに残さない。
- 作業は常にmaster branchで行い、一まとまりの作業ごとにcommitしてoriginと同期する。
- markdown等のドキュメントファイルは、明示的な依頼がない限りrepository内に作成しない。
- テストはロンドン学派に従い、ユニットテストのみを書く。

## 設計

- `coppice` コマンド1つで、次のsub commandを提供する。
  - `coppice run <指示>`: single turnのCLI。stderrに実行状況、stdoutに最終結果を出す。
  - `coppice tui`: multi turnのTUI。
  - `coppice web`: multi turnのweb UI。
  - `coppice agent`: agent実行基盤プロセス。
- 3つの実行形態はすべて、統一されたagent processで実行する。
  - agent processは `127.0.0.1:$COPPICE_PORT`（既定 4517）でREST APIを提供する。
  - 各実行形態はagent processが起動していなければ同じnodeでdetachedに起動し、指示を送り、結果のeventをlong pollingで取得する。
- REST API
  - `GET /health`
  - `POST /sessions` `{cwd}` → `{id}`
  - `POST /sessions/:id/turns` `{input}` → `202`
  - `GET /sessions/:id/events?after=<seq>&wait=<ms>` → `{events}`。`after` より新しいeventが無ければ `wait` まで待つ。
- event: `turn_started` / `code` / `code_result` / `message` / `turn_completed` / `turn_failed`。各eventは単調増加の `seq` を持つ。
- model: OpenAI Responses API。`store: false` で履歴はagent processが保持する。model名は `COPPICE_MODEL`。
- tool: code modeの `run_code`（custom tool、freeformのJavaScript）のみを公開する。
  - agent processと同じnodeの `node:vm` で実行する。
  - globalは `tools`（`listFiles` / `readFile`）と `out()`。`out()` した値と `return` した値だけをmodelに返す。
  - fileへのアクセスはsessionの `cwd` 配下に限る。

## 構成

- TypeScript、ESM。`src/` → `dist/`（`npm run build`）。
- linter/formatterはbiome（`npm run check`）、テストはvitest（`npm test`）。テストは対象と同じディレクトリに `*.test.ts` で置く。
