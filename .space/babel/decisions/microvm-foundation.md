---
status: stable
governance: context
tags: 
  - MicroVM
  - CDK
  - cdkd
  - IAM
code_refs: 
  - infra/**
  - image/**
  - tests/**
  - cdk.json
sources: 
  - resource: infra/microvm-foundation-stack.ts
    title: MicroVM基盤実装
  - resource: .space/tasks/microvm-foundation/task.md
    title: 設計比較とローカル・AWS実機検証記録
  - resource: .space/tasks/microvm-foundation/evidence/container.json
    title: ARM64コンテナ検証
  - resource: .space/tasks/microvm-foundation/evidence/aws-smoke.json
    title: AWS上の起動・認証付き応答・終了の証拠
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
    title: AWS MicroVM images
  - resource: https://github.com/go-to-k/cdkd/blob/f71b30f075316d85c53eac95e2ea966e0278f0f5/src/provisioning/providers/lambda-microvm-image-provider.ts
    title: 固定版cdkdのMicroVM provider
  - resource: .space/tasks/session-management/task.md
    title: 名前付きセッションとVS Codeの実装・検証
  - resource: .space/tasks/desktop/task.md
    title: デスクトップ追加とイメージ6.0の検証
type: decision
title: MicroVMイメージを単一のCDKスタックで構成する
description: イメージ資材と最小権限を単一CDKスタックにまとめる設計、CDKとAPIの差、および東京リージョンでのビルド・VM起動・認証付き応答の確認結果を記録する。
generated: 
  by: agent:codex
  at: 2026-10-20T08:06:12.554Z
---
# MicroVMイメージのCDK基盤

2026年10月19日、CLI限定の開発環境の最初の実装として、単一のMicrovmFoundationスタックとCDK Assetによる構成を採用した。最初にローカルで検証し、同日のSSOプロファイル指定と実行依頼を受けてAWSへデプロイした。イメージ作成、VM起動、認証付き応答と検証VMの終了まで確認済み。

## 構成と境界

image/のDockerfile、server.mjs、mvm-sshd、mvm-desktop、desktop.mjsだけをCDK Assetに渡し、内容ハッシュを持つZIPとして扱う。cdkdがbootstrapで用意する資材用ストレージへ配布する。スタックが所有するリソースはビルド用IAMロール、CloudWatch Logsグループ、MicroVMイメージの三つ。イメージはARM64・2 GiBで、名前はlambda-microvms-link-devに固定する。出力はImageArnとBuildLogGroupName。

ビルドロールはlambda.amazonaws.comによるsts:AssumeRoleとsts:TagSessionだけを信頼する。権限は当該ZIP一個のs3:GetObjectと、専用ロググループ内のlogs:CreateLogStream・logs:PutLogEventsに絞る。CDK 2.273のAsset.grantReadは共有バケット全体を許可するため使わず、同じAssetのキーからオブジェクトARNを作る。権限はロール内のinline policyに含め、イメージはロールとロググループの完成に依存する。ビルドロールと将来のVM実行ロールは別の責務として扱い、今回は実行ロールを作らない。

ログデータの保持は7日、スタック削除時はロググループを保持する。同名で再構築する際は保持されたログの扱いを先に決める。失敗時はcdkdのevents・stateとビルドログを確認してから再試行する。資材内容の変更はURIと取得権限を更新し、同じイメージの新versionを作る入力になる。

## 選択理由と代替

専用S3バケットを別スタックで作り、独自処理でZIPをアップロードしてからイメージスタックにURIを渡す案も独立に検討した。今回の要件には独立した成果物配布やアカウント間共有がなく、その案は二つのデプロイと手動の受け渡しを増やすため採用しなかった。単一スタック案ではcdkdの資材保管先へのURIとIAM ARNの書換えに依存する。固定版ソースに加え、実AWSで両方が同じ資材オブジェクトを参照し、イメージをビルドできたことも確認した。

CDK 2.273.0のCfnMicrovmImage型とCloudFormationスキーマは、CreateMicrovmImage APIでは任意のBaseImageVersion、AdditionalOsCapabilities、EgressNetworkConnectors、EnvironmentVariablesも必須としている。cdkdの直接API経路に合わせ、CfnResourceで必要な設定だけを渡す。イメージのCloudFormation-Validate::F3003のみを理由付きで承認する。他のリソースや検証ルールは無効化しない。CloudFormation経由のcdk deploy対応は確認していない。

BaseImageVersionは省略時にAWSの最新を使い、実在する版を確認後にcontext baseImageVersionで指定できる。初版DockerfileはNode.js 24 Alpine系だった。SSH追加時にDebian Bookworm系へ変更した。タグは更新されるため完全なビルド再現性は保証しない。healthとready/validateフックを維持し、OpenSSH・rsync・Gitを追加した。ホスト鍵はビルド時に除去し復元後に生成する。固定資格情報は格納しない。

## 確認済みの範囲

型検査、実スタックの合成、認証情報を外したcdkdによるassembly読取、IAMと依存関係、資材の変更検出、不要ファイルの除外、実プロセスのHTTP応答がローカルで合格した。ARM64コンテナをビルドし、UID 1000でhealth・ready・validateがHTTP 200を返すことも確認した。独立した2担当のレビューで修正必須の指摘はなかった。

## AWSでの初回確認

プロファイルAdministratorAccess-242201303782、アカウント242201303782、東京ap-northeast-1で確認した。初期状態に同名のCloudFormationスタック、MicroVMイメージ、ロググループ、cdkd状態バケットはなかった。cdkd bootstrapで状態S3・資材S3・コンテナ資材ECRを作成し、diffとdry-runで新規3件、更新・削除0件を確認した。

full-wait付きデプロイは116.08秒で成功し、イメージlambda-microvms-link-devはCREATED、version 1.0はSUCCESSFUL / ACTIVEとなった。基底イメージは東京のal2023-1、version 1.0。状態保存はcdkd-state-242201303782、資材はcdkd-assets-242201303782-ap-northeast-1を使う。ビルド用ロールMicrovmFoundation-BuildRoleのGetObjectは実際に配布されたZIP一個だけを許可し、明示したロググループへの書込みとビルドが成功した。デプロイ後の差分は0件だった。

このイメージから最大存続300秒の検証VMを起動した。未認証のhealthは403、8080番だけを許可した5分間有効のトークン付き要求は200とstatus:okを返した。トークンは保存していない。検証後のGetMicrovmでTERMINATEDを確認した。AWSによるイメージ作成と、そこから起動したアプリの応答が成立することを示す。

実行証拠は `.space/tasks/microvm-foundation/evidence/aws-smoke.json`。検証VMは終了し、イメージ・ビルドロール・ログ・bootstrap保管先は次の開発用に保持した。この初回確認時点ではCLI・コマンド実行・同期が未実装だった。CLIとSSHは後続の判断に従い実装済み。自動同期とサスペンド／レジュームは未実装。

[ツールの選択と導入](cdkd-development-tooling.md)と[CLI限定の目的・範囲](../knowledge/microvm-development-environment-scope.md)に基づく。詳細な設計比較・ローカル検証は作業記録 `.space/tasks/microvm-foundation/task.md`に残す。

## 2026年10月20日のSSHイメージ更新

[Bun CLI](bun-microvm-cli.md)へ[WebSocket経由のSSH](ssh-over-websocket.md)を追加した。mvm-sshdを資材許可リストへ加え、Debian/OpenSSH/rsync/Gitとnode所有の/workspaceを格納する。リソースは従来の3つ、ビルド権限は新ZIP一個の参照へ更新し、追加権限は不要。VM実行ロールは引き続きない。

Bun経由cdkd full-waitでimage3.0へ更新成功。更新2件、追加・削除・置換0件、最新runはSUCCEEDED、LatestActiveImageVersion=3.0、再diffは0件。イメージ2.0で判明したsshd stdin継承の不具合を3.0で修正した。正式版3.0のhealth、SSH、転送、鍵分離、PTYを実AWS確認し、全検証VMを終了した。証拠は.space/tasks/ssh-over-websocket/evidence/に保存した。

## 2026年10月20日のVS Code向け更新

VS Code Remote-SSHのLinux前提を満たすためDockerfileへcurlを追加した。開発用アカウント242201303782、ap-northeast-1、MicrovmFoundationへcdkd full-waitで反映し、image4.0を作成した。更新2件、追加削除0件、最新runはSUCCEEDED、再diff0。取得権限は新ZIP一個への参照に置き換わる。CloudFormationへの管理移行は行っていない。

追加インストールしていない4.0のVMでcurlの存在、SSH、VS Code Serverの初回導入と/workspaceへの接続、再接続、終了を確認した。検証VMは終了済み。証拠は.space/tasks/session-management/evidence/cdkd-deploy.log、cdkd-state.json、cdkd-events.log、cdkd-final-diff.log、fresh-smoke.json。名前付きセッションの設計は対応する判断記録に分離した。

## 2026年10月20日のデスクトップ更新

Xfce、TigerVNC、sandbox有効Chromiumとmvm-desktop/desktop.mjsを資材に加えた。既存のSSH経路とprivate Unix socketを使い、AWSの公開ポート・VM実行ロール・追加OS capabilityは増やさない。cdkd full-waitでimage5.0を作成し、初回Chromium待機を延長したimage6.0で実AWSの新VM初回接続まで確認した。更新は各回0追加・2更新・0削除、最終runはSUCCEEDED、LatestActiveImageVersion=6.0、再diffは0件。検証VMは全て終了済み。証拠は.space/tasks/desktop/evidence/のcdkd-state-final.json、cdkd-events-final.log、cdkd-final-diff.log、aws-fresh-desktop.json。GUIの寿命・接続境界・検証の詳細は[デスクトップの判断](desktop-over-ssh.md)に分離した。

## 2026年10月20日の初回GUI起動修正

image6.0でXvncの準備待ち失敗をユーザーが報告した。GUI起動全体の期限とプロセス終了検知を修正し、cdkd full-waitでimage7.0へ更新した。0追加・2更新・0削除、LatestActiveImageVersion=7.0、最終diffは0件。新VM二つで最初のdesktop準備が成功した。CLIも既知の失敗段階を表示するように更新した。変更理由と回帰検証は[デスクトップの判断](desktop-over-ssh.md)へ記録し、実行証拠は.space/tasks/desktop/evidence/startup-fix/に置く。

# Related Concepts
- [名前付きセッションを端末のSQLiteで管理する](named-sessions.md): イメージ4.0へcurlを追加する根拠となったVS Code初回接続とセッション検証。
