# Bun CLIの初版

## 依頼と範囲

2026年10月20日、ユーザーはBunでCLIを実装するよう依頼し、初版を「VMの起動・一覧・状態・接続確認・終了まで」と選択した。OSS公開を前提に、AWSアカウント・リージョン・SSO認証へ固定しない。ブラウザ対応、VM内のexec・ファイル転送は今回の対象外。

進行状態: 完了。成果判定: C1〜C7合格。各種クラウドロールの実環境と他OS向け配布は未検証。

## 受け入れ条件

- C1: Bunからhelp/versionと5操作を実行でき、引数不正ではAWSへ要求しない。
- C2: profile/regionを任意指定でき、未指定ではAWS SDKの標準認証・リージョン設定を使う。環境変数、一時認証情報、共有プロファイル、credential_processをローカルの署名付き要求で確認し、SSOは既存AWS環境で確認する。実環境のない方式は未検証と区別する。
- C3: 起動はイメージを明示し、上限付きの存続時間と冪等性トークンを持つ。起動待ちが失敗してもVM IDまたは再試行用トークンを返す。状態の正本はAWSに置く。
- C4: 一覧のページを取りこぼさず、状態を表示する。終了は明示IDのみを対象とし、終了済みへの再実行を許す。
- C5: 接続確認では8080番を既定とするポート限定・短命トークンでHTTPS要求し、トークンを標準出力・標準エラー・ファイルへ出さない。HTTP失敗と成功を区別する。
- C6: JSON出力、終了コード、期限付き待機を用意する。端末の対話操作を必須としない。
- C7: 実CLIの起動・一覧・状態・接続確認・終了を、既存イメージから作る検証専用VMで通す。作成したVMは終了まで確認する。既存VM・イメージは変更しない。

## 工程と担当

標準規模。新規CLIと認証・接続を扱うため、独立2案の設計比較と実装後の独立レビューを行う。既存の基盤・Bun設定・SDK対応の調査結果を再利用する。

- 設計A: VM IDを明示しローカル状態を持たない案。担当 cli_design_a、所有 `design-candidates/initial/a.md`。
- 設計B: プロジェクト設定と選択VMを保存する案。担当 cli_design_b、所有 `design-candidates/initial/b.md`。
- 親: 比較・採用、src、package設定、テスト、README、実機検証、OKF保存を担当する。共有ファイルは親だけが編集する。

実装単位は、CLIとSDK境界、失敗時と認証のローカル検証、実機検証と説明の順にする。依存を先に固定し、設計比較後にソースを実装する。AWSへの公開・イメージ更新・パッケージ公開・コミットは今回行わない。

## 調査で確認した事項

- 導入済みSDKは `@aws-sdk/client-lambda-microvms@3.1152.0`。clientのprofile指定は認証と共有設定の双方に適用できる。
- RunMicrovmにclientTokenと1–28,800秒のmaximumDurationInSecondsがある。ListMicrovmsにはimageIdentifierとnextTokenがある。
- 接続トークンはポートを限定できる。既存イメージはGET /healthに応答し、VM側を変更せず初版の経路を確認できる。
- 根拠: AWS公式MicroVMのlaunching/security/networkingドキュメント、SDKの配布型定義、既存基盤の検証記録。

## 検証記録

2026年10月20日、Bun 1.4.2 / macOS ARM64で確認した。今回の版は未コミットのsrc、package設定、tests/cli.test.ts、README。実AWSで動かした実行ファイルのSHA-256は `evidence/aws-smoke.json` に保存した。

| 条件 | 結果・根拠 |
| --- | --- |
| C1 | help/version、5操作と不正引数を実CLIの子プロセスで確認。不正時はAWS代替サーバへの要求0件 |
| C2 | 環境変数とセッショントークン、共有profile、profileのregion、明示region、credential_process、AWS_PROFILEを署名付き要求で確認。認証不在とprofile併存のJSONエラーも確認。SSOは下記の実AWS操作で成功 |
| C3 | Runのduration/clientToken、RUNNING待機、no-wait、時間切れと中断のID保持、ID不明時のtoken保持を確認 |
| C4 | 全ページ取得、20,000件のJSON全量出力、終了待ち、TERMINATEDへの再実行を確認 |
| C5 | 1分・単一portのトークン、HTTPS、リダイレクト非追跡、本文/通信例外の秘密非表示を確認。裸ホスト名とHTTPS URL、HTTP/userinfo/path拒否も確認。実AWSでcheck 200 |
| C6 | JSON/exit 0・1・2・130、遅いcredential_processもtimeout 1秒で約1.06秒終了、待機期限と中断を確認 |
| C7 | コンパイル済みdist/mvmを/tmpから実行。profile AdministratorAccess-242201303782、ap-northeast-1、image version1.0、duration300秒。新規VM microvm-59393af3-3827-3709-a2f7-9b6d145e098fでstart/list/status/check/stop成功、再取得でTERMINATED、stop再実行も成功 |

最終の `mise exec -- bun run verify` は型検査成功・14テスト成功。`bun run build`、リポジトリ外での単体help/version、frozen-lockfile install、git diff --checkも成功した。既存の基盤とイメージの3テストも含む。AWSの操作は `aws-smoke.mjs`、成功記録は `evidence/aws-smoke.json`。

初回の実AWS確認では、endpointがスキームを持たないホスト名だったためcheckがInvalidEndpointとなった。起動したmicrovm-2f6547c5-3cc6-369d-8d79-798dc4d965ebはfinallyで終了しTERMINATEDを確認済み。失敗記録は `evidence/aws-smoke-before-endpoint-fix.json` に保持し、ホスト名からHTTPSへの正規化を修正してから再確認した。

## レビューと修正

cli_design_a / cli_design_bが実装を読み取り専用で独立レビューした。同一モデルの別担当で、他担当の指摘は共有せず確認した。両者による先行調査の再利用範囲はsrc/のcode_refsなし、tests/のfoundation、Bun tooling/scope、境界/体験/冪等性/型/振る舞い検証の原則。追加の制約は検出していない。

- 両者: 遅いcredential_processがCLIの終了を遅らせる指摘を採用。4秒のproviderでtimeout1秒の回帰テストが修正前4,086msで失敗し、入口で出力完了後にexitする修正後は約1,060msで成功。
- Bと親: profileと環境変数が併存するとSDK警告がJSONへ混ざる指摘を採用。成功/認証失敗のケースで再現後、SDK loggerを抑制し、CLI所有のエラー表示へ統一。
- A: 明示exit導入後の大量出力切断を採用。20,000件のJSONが修正前に解析失敗。実際の出力write callbackを待つ修正後、全件と末尾IDを確認。Aの独立再確認でも3,648,905 bytes全量・JSON解析成功。
- 親の実AWS確認: 裸ホスト名をHTTPSへ正規化。回帰確認は修正前失敗、修正後成功。AがHTTPS以外・userinfo・path・query・fragment拒否も再確認。

最終の独立再確認で、指摘した問題は解消、追加の修正必須事項なし。実AWS検証は親が担当。ブラウザ、exec/shell、ファイル転送、イメージの再デプロイ、パッケージ公開は今回の範囲外。AssumeRole/OIDC/ECS/EC2は標準SDKへ委ねるが、その実環境では未検証。VMのegressはAWS既定のパブリックインターネット接続であり、遮断機能ではない。

## 知識保存

OKF CLIで `decisions/bun-microvm-cli` を作成し、`knowledge/microvm-development-environment-scope` の未実装・言語未決定の記述を更新した。`validate --strict --drift` はerrors/warnings/broken_links/staleすべて0、is_conformant true。既存の共通原則の孤立20件のためstrict gateはfalse。今回の文書に孤立・リンク切れはなく、無関係な原則へ検証通過用のリンクは追加していない。READMEはtechnical-writingとunslopの手順で実装・実測値と照合した。

## 2026年10月20日の試用と名前指定の修正

ユーザーの「少し試してみたい」に沿って5分上限のVMを準備した際、GetMicrovmImageは名前指定をInvalid ARN formatで拒否し、ListMicrovmsの名前filterは既存VMを返さないことを実AWSで確認した。前回の実機試験はARN入力だけだった。名前入力はListMicrovmImagesを全ページ検索してARNへ解決し、Get/Run/Listへ渡すよう修正した。ARN入力の呼び出しは増やさない。READMEに名前指定時のlambda:ListMicrovmImages権限を追記した。

名前解決の回帰テストは修正前ValidationExceptionで失敗、修正後成功。2ページ目の名前を使う開始・一覧、名前不在時のRun抑止を確認。他テストの入力は実APIに合わせARNへ変更した。型検査・15テスト・build・diff --check成功。OKFの既存CLI decisionへ理由を追記し、形式検証のerrors/warnings/broken_linksは0、既存の孤立原則20件は変化なし。

修正確認用microvm-2a3f2df4-3029-36af-a857-b00c772eba09はcheck 200、終了後TERMINATED。修正後は名前指定で新たな試用VM microvm-50caa20d-0d5b-3630-b8e7-27a41e14088fがRUNNINGとなった。ユーザーが手元で操作できるように残し、存続上限300秒（2026年10月20日01:27:29 JST頃）でAWSが終了する設定とした。自動終了後の状態は未確認。

## 設計の採用

親と候補作成に参加していないcli_compareが独立してC1〜C7で比較し、Aを採用した。同一モデルによる独立担当であり、モデルの多様性はない。Bは日常操作を短くするが、初版にinit/use・状態ファイル・排他・アカウント照合を持ち込み、暗黙の終了先はC4に合わない。Bの永続状態は取り込まず将来案として残す。

CLIはstart/list/status/check/stop。mainは実行入口、cliは引数・出力・期限・中断、microvmsはAWSの呼び出し・ページング・状態待機・認証付きHTTP確認を所有する。起動時間は既定3,600秒、上限28,800秒、各操作の待機は既定120秒。起動はRUNNING、終了はTERMINATEDまで待ち、--no-waitでは受理結果を返す。既知IDと再試行用clientTokenは失敗時にも返す。checkは既定8080番/healthへのHTTPSが2xxかを判定し、本文・トークンを出力せず、リダイレクトを追わない。
