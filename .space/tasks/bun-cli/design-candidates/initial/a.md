# 候補A：明示VM IDで操作するステートレスCLI

2026-10-20改訂。担当 `/root/cli_design_a`。独立候補として作成し、他候補は未参照。設計のみで、未採用・未実装。AWS操作と外部仕様の再調査は行っていない。

## 今回の範囲

ユーザーが初版を「VMの起動・一覧・状態・接続確認・終了まで」と確定したため、初稿のexec・ファイル送受信を今回の範囲から外した。exec、shell、upload、downloadは次段階で設計する。Bun 1.4.2標準、OSS公開、SSO以外のAWS認証、ブラウザ不要という要件は保持する。

親から渡された既存構成はTypeScriptのCDK/cdkd基盤と、healthを提供するNode 24のVMイメージ。今回のHTTP接続確認は、その既存イメージへ短命かつポートを限定したトークン付きGETを行う。トークンを表示・保存しない。

AWSのVM状態を唯一の正本とし、CLIは毎回明示されたVM IDを使う。CLI専用の設定ファイル、カレントVM、ローカルVM台帳、常駐プロセスを持たない。CLIはイメージ名またはARNを引数から受け取り、cdkdの状態保存形式に依存しない。

## 利用例

`mvm`はコマンド名の仮称。アカウント・リージョン・プロファイルをリポジトリに固定しない。

```sh
mvm start --image <name-or-arn> --json
mvm list --json
mvm status <id> --json
mvm check <id> --json
mvm stop <id> --json
```

開発中は同じ引数を `bun run cli -- ...` で実行する。共通オプションは任意の `--profile` と `--region`、機械処理用の `--json`。未指定ならSDK標準の設定・認証解決を使う。認証方式ごとの独自ログインや資格情報保存を実装しない。

## 責務と骨組み

公開入口で入力を検証する。管理APIの操作と、短命トークンを使うHTTP接続確認の責務を分ける。

```ts
type AwsOptions = { profile?: string; region?: string };
type StartInput = {
  image: string;
  imageVersion?: string;
  clientToken: string;
  wait: boolean;
  timeoutSeconds: number;
};
type CheckView = {
  vmId: string;
  healthy: boolean;
  statusCode: number;
};

async function startVm(client: LambdaMicrovmsClient, input: StartInput): Promise<VmView>;
async function listVms(client: LambdaMicrovmsClient): Promise<VmView[]>;
async function getVm(client: LambdaMicrovmsClient, vmId: string): Promise<VmView>;
async function stopVm(client: LambdaMicrovmsClient, vmId: string): Promise<VmView>;
async function checkVm(client: LambdaMicrovmsClient, vmId: string): Promise<CheckView>;
```

これは責務の骨組みで、SDK入力・応答型の二重定義を求めない。`VmView`はVM ID、状態、イメージ識別子・版、AWSが返す開始・期限時刻など、確認できた項目に限定した表示形とする。生のAWSレスポンスやトークンをそのままJSONへ出さない。

- `cli/main.ts`：Bunの入口とCommanderのコマンド定義。引数の型変換、表示、終了コードを所有する。
- `cli/vms.ts`：SDKクライアント、管理API操作、ページング、有限時間の状態待機、表示形への変換を所有する。
- `cli/check.ts`：対象VMの現在状態とAWSから返された接続先を取得し、短命トークン発行とHTTP health判定を所有する。管理資格情報をHTTPリクエストへ転送しない。

表示処理が大きくなった場合に限って `cli/output.ts` へ分ける。CDK・imageソースをCLIライブラリとしてimportしない。各APIを同じ引数で次へ渡すだけの薄い層は増やさない。

## 入出力・失敗・認証境界

- `start`は既定でRUNNINGまで有限時間待ち、`--no-wait`なら受付時のVM IDを返す。待機タイムアウトは作成取消しと扱わず、既知のVM IDと `status` / `stop` による回復方法を返す。
- 起動の同一実行内リトライは同じclient tokenを使う。任意の `--client-token` を受け付け、プロセスをまたぐ再試行でも同じtokenを指定できるようにする。別々の通常 `start` は別VMを作る契約を明示する。
- `list`は選択されたアカウント・リージョンのページングを完了させる。暗黙のカレントプロジェクト絞り込みは行わない。
- `status`はAWSの現在状態を返す。TERMINATEDを不具合扱いせず、RUNNING等と同じ状態値として表示する。
- `check`はRUNNINGを確認してから、既存imageのhealthポートだけを許可する短命トークンを発行する。接続先はAWSの取得結果から決め、任意URLの入力を受け付けない。固定のGET `/health` を有限時間で実行し、HTTP成功と期待するhealth応答を確認する。リダイレクト先へ認証ヘッダーを転送しない。
- checkの結果にトークン・認証ヘッダー・生のトークン発行レスポンスを含めず、例外やデバッグ出力でも表示しない。接続情報とトークンは実行中のメモリでのみ扱う。トークン期限・許可ポートの具体値は既存imageと親のSDK仕様確認に合わせて確定する。
- `stop`は指定したVMだけを終了する。既にTERMINATEDなら成功とし、終了要求の受付と終了完了を区別して表示する。既定では有限時間待機して終了を確認する。対象なしや別リージョンのIDは正常終了へ丸めない。一括終了は持たない。
- 標準出力は結果のみ、進捗・診断は標準エラー。`--json`では最終結果を一つのJSONとし、失敗時も安定したエラー識別子・メッセージ・既知のVM IDを標準エラーへ返す。
- 正常終了は0、操作失敗は1、使い方の誤りは2、中断は130。認証失敗・AccessDenied・対象なし・待機時間超過・HTTP接続失敗をメッセージとエラー識別子で区別する。
- Ctrl-Cやタイムアウトで作成済みVMを勝手に削除しない。結果が不明な状態で起動APIを新しいtokenに替えて再送しない。

## 確認する利用経路

初版の縦断経路は `start → list/status → check → stop → status`。既存イメージで実際に接続を確認し、最後の状態がTERMINATEDになることを確認する。help/不正引数/JSON、待機タイムアウト後のVM ID、API拒否、非RUNNINGへのcheck、HTTP異常、秘密値が出力されないことはCLI入口または境界から検証する。

認証方式はSDK標準チェーンへ委ねる一方、環境変数・名前付きプロファイル・既存SSOなどの確認結果を分けて記録する。全方式を実機検証したと誤認させない。AWS実機検証は親の承認・計画の範囲で行い、この候補担当は実行しない。

## 利点・不利益・未確認事項

ローカル台帳がないため、CIや複数エージェントが台帳ロックを共有せず利用できる。古いカレントVMやコピーした設定による誤接続経路を減らせる。代わりに利用者は各操作へIDを渡し、起動したIDを失った場合はlistで探す必要がある。プロジェクト名だけの操作、自動再利用、常時同期は初版の契約に含めない。

状態保存を持つ別構造はAWSとの食い違い、並行更新、原子的保存が必要になるため、この候補では採らない。将来必要なら今回のID指定操作を土台として導入する。

HTTP接続確認の方針は親の確定条件を引き継いだ。SDKの正確なフィールド、health応答、トークン期限の許容値、待機で扱う状態は親の確認結果を統合する必要がある。候補内の利用例と責務・回復方法は照合済みで、コードとAWS動作は未検証。採否・統合・OKF保存は親へ返す。

参照したOKFは `knowledge/microvm-development-environment-scope` と、`principles/boundary-discipline`、`principles/experience-first`、`principles/make-operations-idempotent`、`principles/type-system-discipline`、`principles/separate-before-serializing-shared-state`。ルール0件、原則全件のdescriptionを確認した。境界検証、起動token再利用、共有台帳を持たない判断へ適用した。
