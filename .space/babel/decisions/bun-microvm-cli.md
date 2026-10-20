---
type: decision
title: Bun CLIを明示IDの5操作から始める
description: Bun製MicroVM CLIの責務、標準AWS認証、回復情報と出力の契約、実機検証と未確認範囲を記録する。
governance: context
tags: 
  - MicroVM
  - Bun
  - CLI
  - 認証
code_refs: 
  - src/**
  - tests/cli.test.ts
  - package.json
  - README.md
sources: 
  - resource: .space/tasks/bun-cli/task.md
    title: 設計比較と検証記録
  - resource: .space/tasks/bun-cli/evidence/aws-smoke.json
    title: 実CLIのAWS検証結果
  - resource: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
    title: AWS SDKの認証情報
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
    title: MicroVM networking
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html
    title: MicroVM security
  - resource: .space/tasks/session-management/task.md
    title: 名前付きセッションとVS Codeの実装・検証
generated: 
  by: agent:codex
  at: 2026-10-20T03:36:42.052Z
---
# Bun CLIを明示IDの5操作から始める

2026年10月20日、ユーザーはBun製CLIの初版を起動・一覧・状態・接続確認・終了までと指定した。[目的と範囲](../knowledge/microvm-development-environment-scope.md)に従い、TypeScript/BunとAWS SDK v3で実装した。コマンド名はmvm、版は0.1.0。OSS向けの公開・他OS向け配布は未実施。

## 採用した構造と理由

初版はstart/list/status/check/stopで、操作対象のIDを明示し、AWSを状態の正本とした。現在はSSH操作と名前付きsession操作を追加している。従来のID指定操作は引き続きローカル設定を必要としない。独立候補Bのプロジェクト設定・選択VM・ロック案は、初版に初期化と復旧手順を増やすため見送った。候補作成に関与しない比較担当もAを推奨した。

src/main.tsは入口、src/cli.tsは入力検証・表示・期限・中断、src/microvms.tsはAWS API・ページング・状態待機・HTTP確認を所有する。[境界を分ける原則](../principles/boundary-discipline.md)に沿い、SDKの通信形式やトークンをCLI利用側へ漏らさない。SDK/Commanderは固定依存、Bunのcompileで単体実行ファイルを作る。CDK基盤は[既存のイメージ](microvm-foundation.md)をそのまま利用する。

## 操作の契約

startはimage必須、既定存続3,600秒・上限28,800秒。既定でRUNNING、stopはTERMINATEDまで待つ。--no-waitで待機を省略でき、stopでは受付結果のみ返す。操作の期限は既定120秒。時間切れと中断はVMの終了を意味せず、既知IDを回復情報に返す。起動結果が不明なら生成済みclientTokenと入力を返し、同じtoken・入力での再試行へつなぐ。[冪等性の原則](../principles/make-operations-idempotent.md)に従い、新しいtokenでの自動再起動はしない。AWSのtoken有効期間を超えた保証はしない。

listは全ページを取得する。stopは明示IDだけを対象とし、終了済みへの再実行も成功する。--jsonは成功をstdout、単一エラーをstderrに返す。終了コードは0成功、1操作失敗、2引数不正、130中断。

認証とregionはSDKの標準解決に任せ、profile/regionを任意指定できる。特定のSSO・アカウント・リージョンへ固定しない。実行ロールは渡さずCloudWatch実行ログはdisabled。初版はALL_INGRESSを指定していた。SSH追加後はHTTP_INGRESSとSHELL_INGRESSを指定する。egressはAWS既定のインターネット接続となる。

checkは既定8080番/healthへの認証付きHTTPS GETが2xxかを判定する。アプリ本文の検証ではない。AWSのendpointは裸ホスト名を返すためHTTPS URLへ正規化し、HTTP/userinfo/path/query/fragmentを拒否する。トークンは指定portのみ・1分、保存や表示をしない。リダイレクトを追わず、HTTP本文と生の通信例外を出力しない。

## 実装で確認した制約と修正

SDKのcredential_processはAbortSignalだけでは止まらず、process.exitCodeのみではCLIが期限を超えて残る。結果/エラーを実際に書くwrite callbackを待ってから実行入口でexitする。空文字writeのcallbackはBunで先行する大量出力の完了を保証せず、20,000件のJSON切断を再現したため使用しない。

profileと環境変数資格情報の併存ではSDKがconsole.warnへ出力する。SDK loggerを抑制してJSONを保ち、認証失敗をCLI所有の安全な文面へ変換する。外部credential_process自身の生存期間をCLIが管理する設計ではない。

## 検証と未確認

Bun1.4.2/macOS ARM64で型検査と14テストが成功。実CLIプロセスで引数・ページング・20,000件出力・待機・期限・SIGINT・回復情報を確認した。環境変数とsession、共有profile/region、credential_process、AWS_PROFILEの署名付き要求と認証不在をローカルで確認。checkのport/TTL/HTTP失敗/秘密非表示を確認。

コンパイル済みCLIを/tmpから起動し、SSO profile AdministratorAccess-242201303782・ap-northeast-1のimage version1.0で5操作が成功。checkは200、検証VM microvm-59393af3-3827-3709-a2f7-9b6d145e098fはTERMINATED。初回のendpoint形式不一致で失敗したVMも終了済み。実証ファイルと実行ファイルSHAは ".space/tasks/bun-cli/evidence/aws-smoke.json" に記録した。

AssumeRole/Web Identity/ECS/EC2の実環境、macOS ARM64以外の実行、最小権限IAM主体での実証は未検証。初版ではexec/shell・ファイル転送・Suspend/Resumeを対象外とした。現在のSSHと転送は後述の追加判断に従い、Suspend/Resumeは引き続き未実装。

## 2026年10月20日の名前指定修正

ユーザーのお試し操作で、GetMicrovmImageへ名前を渡すとInvalid ARN formatとなり、ListMicrovmsの名前filterは対象VMを返さないことを実AWSで確認した。従来の実機検証はARNのみ、ローカル代替APIは名前を受け付けたため未検出だった。

名前入力はListMicrovmImagesの全ページから完全一致で探してARNに変換し、Get/Run/ListへそのARNを渡す。名前がなければImageNotFoundで止め、Runしない。ARN入力では画像一覧を呼ばず、追加のlambda:ListMicrovmImages権限は名前指定時だけ必要。アカウント番号を推測・固定してARNを組み立てない。

複数ページでの名前解決、開始/一覧へARNを渡すこと、存在しない名前でRunしないことを実CLIテストへ追加し、修正前のValidationExceptionと修正後の成功を確認した。他のAPI代替テストはARN指定に変更し、実APIの入力条件へ合わせた。型検査・15テスト・単体実行ファイルのビルド成功。

## 2026年10月20日のSSH追加

[WebSocket経由のOpenSSH](ssh-over-websocket.md)を追加し、sshとwith-sshを公開した。管理5操作の契約は維持する。SSH系は--jsonを拒否し、子の出力・終了コードを透過する。接続準備の期限と接続後の寿命を分離する。HTTP_INGRESS+SHELL_INGRESSへ変更したため、旧CLIで起動したVMは作り直す。

通常verifyは24 passと任意Docker1 skip、Docker実SSHは別途成功。image3.0で対話操作、コマンド、scp/SFTP、rsync、同時接続、鍵拒否を実AWS確認し、検証VMはすべて終了した。自動同期は未実装。設計理由と検証証拠は上記の判断記録へ分離した。

## 2026年10月20日の名前付きセッション追加

ユーザーの承認に従いsession create/list/status/ssh/with-ssh/code/stop/recoverを追加した。名前・プロジェクト・AWS環境・VM・接続設定をSQLiteで保持し、終了したCLIから再接続できる。初版で見送った永続管理を今回の要件として導入したもので、従来のID指定操作は維持する。AWSの照合失敗をUNKNOWNとして返し、起動結果不明時のRun自動再送は行わない。

型検査、46テスト成功、任意Docker1件skip、compiled CLIのビルド成功。イメージ4.0で名前付き起動・SSH再接続・VS Code初回接続・終了・鍵削除を実AWS確認した。検証VMは終了済み。保存と復旧の詳細は名前付きセッションの判断記録、証拠は.space/tasks/session-management/evidence/に保存した。

# Related Concepts
- [名前付きセッションを端末のSQLiteで管理する](named-sessions.md): 名前付き管理で追加した保存・認証先照合・起動復旧・VS Code接続の設計と検証。
