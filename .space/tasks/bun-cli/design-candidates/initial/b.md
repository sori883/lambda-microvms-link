# 候補B：プロジェクトが作業用VMを選択するCLI

2026-10-20。担当 `/root/cli_design_b`。独立した設計候補であり、採用・実装・AWS実証は未実施。他候補は参照していない。親から受けた最新のユーザー指定により、初版は起動・一覧・状態・接続確認・終了だけを対象とする。

## 利用例

仮のコマンド名を `mvm` とする。一度イメージを設定し、以降はVM IDを毎回渡さず作業する。

```sh
mvm init --image <image-arn>
mvm up --profile dev --region ap-northeast-1
mvm status --json
mvm health --json
mvm list --json
mvm down
```

`use <vm-id>` で既存VMを選択し直せる。`list` は解決したAWSアカウント・リージョンの一覧を返し、選択中のVMを区別する。AWSの実状態を正本とし、ローカル状態だけでRUNNINGを報告しない。exec、shell、ファイル送受信、Suspend / Resumeは今回の実装範囲外。

## 設定と状態

共有可能な `microvm.json` と、Git対象外の `.microvm-link/state.json` を分ける。前者はイメージ・最大寿命を持ち、プロファイル名と認証情報は入れない。初期化時に `.microvm-link/.gitignore` を生成して配下を除外する。

```ts
type ProjectConfig = {
  schemaVersion: 1;
  image: string;
  imageVersion?: string;
  maximumDurationSeconds: number;
};
type AwsContext = { accountId: string; region: string; profile?: string };
type Selection = { context: AwsContext; microvmId: string };
type ProjectState =
  | { schemaVersion: 1; kind: 'empty' }
  | { schemaVersion: 1; kind: 'starting'; context: AwsContext;
      clientToken: string; requestedAt: string; request: StartRequest }
  | { schemaVersion: 1; kind: 'selected'; selection: Selection };
```

状態には選択と起動途中の記録だけを持つ。認証トークン、AWSキー、毎回変わるVMステータス、エンドポイントは保存しない。設定探索は `--project <dir>` を優先し、未指定ならカレントから親へ `microvm.json` を探す。グローバル台帳は作らない。

## 責務と骨組み

`cli.ts` はCommanderによる引数解析、JSON／文字表示、終了コードを持つ。`project.ts` は設定・状態・排他制御を所有する。`microvms.ts` はSDK呼び出し、VMの状態遷移、待機、認証付きHTTP接続確認を所有する。別サービスへの拡張だけを目的とする汎用層は作らない。

```ts
loadProject(directory: string): Promise<Project>;
resolveAwsContext(options: AwsOptions, selection?: Selection): Promise<AwsContext>;
up(project: Project, aws: AwsContext): Promise<VmSummary>;
select(project: Project, aws: AwsContext, microvmId: string): Promise<VmSummary>;
status(selection: Selection): Promise<VmSummary>;
health(selection: Selection): Promise<HealthResult>;
list(aws: AwsContext): Promise<VmSummary[]>;
down(project: Project, selection: Selection): Promise<VmSummary>;
```

設定・状態・CLI引数・AWS応答は各入力境界で検証する。SDK型を永続形式や利用者向けJSONへそのまま流さない。healthは既存イメージのポート8080の `/health` へ、短命・当該ポート限定の認証トークンでGETする。トークンはメモリ内だけで使い、ログ・JSON出力・状態ファイルに含めない。認証付きHTTP応答成功は管理APIのRUNNINGとは別の結果として表示する。

## 認証・失敗・再実行

- AWS SDK標準のprovider chainを使い、`--profile` は任意。独自SSOログイン、キー保存、特定アカウントの固定はしない。初回リージョンは明示指定またはSDK標準設定から解決し、無ければ設定エラー。後続操作は選択のリージョンを使う。
- 選択はアカウント・リージョン・VMの組で保持する。別リージョン指定や、プロファイルの認証先変更を検出したら、暗黙に別VMを操作せず不一致を返す。現在のアカウント照合方法と追加API呼び出しは実装時に確定する。
- `up` は選択済みVMをAWSで確認し、利用可能なら再利用、終了済みなら新規起動する。アクセス拒否・通信失敗は「VMなし」に読み替えない。`down` は終了確認後に選択を空にする。終了済みの再実行は成功へ収束する。
- 起動・選択・終了だけをプロジェクト単位で排他制御し、状態保存は一時ファイルとrenameで行う。ロックは所有プロセスを識別する情報を持ち、安全に判断できないロックを時間だけで自動解除しない。
- Run前にclient tokenと正確な起動入力を保存する。途中中断は同じ入力で回復する。APIの冪等性期間外・結果不明なら新規起動せず、一覧と `use` による復旧を案内する。起動後の状態保存失敗ではVM IDを必ず表示する。
- 待機タイムアウトはVM終了を意味しない。選択／起動記録を残し、状態確認と終了を案内する。health失敗でもVMを自動終了させない。
- 通常の結果／`--json` の単一結果はstdout、進行表示と診断はstderrへ出す。失敗は非0終了とし、入力不備・認証／権限・状態不整合・通信／タイムアウトをcodeで識別できる。必要なAWS request IDは残し、例外全体や認証値を丸ごと表示しない。

## 利点と追加コスト

最も頻繁な `status` / `health` / `down` でVM IDとAWS接続先を繰り返さずに済み、ローカルのAIエージェントはプロジェクトディレクトリだけを指定できる。プロジェクトを切り替えても、別プロジェクトのVM選択を上書きしない。

代償は初版から `init` / `use`、状態形式、排他、起動途中の回復が必要になること。VM ID必須の方式ならこれらを削減できる。今回確定した5操作だけなら、B案の便利さより実装・検証コストが勝る可能性がある。継続的な同一プロジェクト操作が主目的ならB案が有利だが、最小のライフサイクル実証を優先する場合は設定・選択を後回しにする判断が合理的。

## 根拠・確認・残件

親の基盤検証を再利用し、現行 `package.json`、`bunfig.toml`、`mise.toml`、AGENTSでBun1.4.2標準を確認。OKFは `knowledge/microvm-development-environment-scope` と `decisions/cdkd-development-tooling` を参照。全rule検索は0件。全principleのdescriptionを確認し、boundary-discipline、experience-first、foundational-thinking、make-operations-idempotent、model-the-domain、separate-before-serializing-shared-state、type-system-discipline、minimize-reader-loadの本文を読み、入力境界・状態所有・回復・汎用層を増やさない判断へ反映した。

利用例と型・失敗経路は自己照合済み。実装検証は未実施。未確認はAWSの起動client tokenの有効期間、現在アカウント照合、SDK標準認証各方式のBun検証範囲。接続確認の方式は親が確認した既存HTTPイメージ＋ポート限定トークンを採用候補とし、独自のネット調査やAWS操作は行っていない。最終的な採用・統合と受け入れは親へ返す。
