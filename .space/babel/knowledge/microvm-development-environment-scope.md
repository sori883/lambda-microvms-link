---
type: knowledge
title: MicroVM開発環境の目的と範囲
description: OSSのCLIを入口とするMicroVM開発環境の目的と範囲。SSOに限定しない認証、基盤・VM・CLIの区分、名前付きセッションとデスクトップの追加要件を記録する。
governance: context
tags: 
  - MicroVM
  - Lambda
  - 開発環境
  - スコープ
sources: 
  - resource: /Users/const/.codex/attachments/f654fa7b-2b4b-4c39-9d93-fa5047a0fdf2/貼り付けたテキスト.txt
    title: ユーザー提供の2026年10月19日時点の引き継ぎ
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
    title: Running and using MicroVMs
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
    title: MicroVM images
  - resource: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.CfnMicrovmImage.html
    title: AWS CDK CfnMicrovmImage
  - resource: https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html
    title: Security and permissions
  - resource: .space/tasks/session-management/task.md
    title: 名前付きセッションとVS Codeの実装・検証
  - resource: .space/tasks/desktop/task.md
    title: デスクトップ追加のユーザー要件と実AWS検証
generated: 
  by: agent:codex
  at: 2026-10-20T05:34:50.358Z
---
# MicroVM開発環境の目的と範囲

2026年10月19日のユーザー提供の引き継ぎと、同月20日までの会話で確定した範囲を記録する。実装状況とは分けて扱う。

## 作りたい体験

プロジェクト単位の隔離されたAWS Lambda MicroVMで、コーディングと各種コマンドを実行する。参考はlllのデモ。CLIでVM起動、手元とVMのファイル同期、シェルとexec、一覧と再接続、Suspend／Resume、複数VMの並列実行を扱う。

デモの機能はユーザー提供の引き継ぎにあるスクリーンショットの説明に基づく。このプロジェクトでは動画全体とlllのソースを確認していない。デモの表示から内部実装を断定しない。

## ユーザーが確定した方針

- 2026年10月19日の選択回答で「CLIから始める：手元のCodexやClaude CodeからVMを使う」を選択した。
- 続く発言で「まずブラウザ対応考えなくていい」「CLIで基本的には完結させたい」と明示した。この時点ではCLI単独とし、Webチャット・noVNCを対象から外した。その後、2026年10月20日にユーザーがデスクトップとブラウザを依頼したため、CLIから開くnoVNCを追加対象にした。Web管理画面・Webチャットは引き続き対象外。
- エージェントは基本的に手元のCodexやClaude Codeを利用する。VM内でAIエージェントを動かす機能は初期の前提にしない。
- 必要なものとして、MicroVMを作る仕組み、権限やCDKなどのAWS環境準備、CLI本体を挙げた。その後、CLIはTypeScript/Bunで実装した。
- 長期アーカイブ、1年後の再開、期限切れ後の実行中プロセスの完全復元は当面対象外。短期の作業ファイルの回収・同期は対象に含む。
- スマホでも読める説明を優先し、Mermaidの図だけに依存しない。
- 2026年10月20日、cdkdを含む手元の実行環境とパッケージ管理はBunを標準にするようユーザーが指定した。設定と動作確認は[開発ツールの決定](../decisions/cdkd-development-tooling.md)に記録する。
- 2026年10月20日、OSSとして公開する方針と、SSO以外の認証にも対応する要件をユーザーが明示した。手元のSSOプロファイルでの成功だけを製品の認証対応範囲とせず、利用者それぞれのAWS認証環境を対象に設計・検証する。実装はSDKの標準認証解決を使う。確認済みの方式と実環境の未検証範囲は[CLIの決定](../decisions/bun-microvm-cli.md)に記録する。

初回引き継ぎではCLI／Webが未決定だった。現在はCLIを操作の入口とし、デスクトップ表示に手元のブラウザを使う。

## 構成を検討する際の区分

引き継ぎのVM管理・接続・同期・イメージという区分を、CLI単独の範囲へ絞って使う。以下は構成の説明であり、実装済みの機能や最終的な詳細設計を意味しない。

1. AWS環境準備：権限、イメージ作成物の保管先、ログ、MicroVMイメージの定義を準備する。CDKで管理する候補。
2. VMイメージ：Gitや言語ランタイムなどの開発用ツールと、CLIからのコマンド実行・ファイル転送を受け付ける仕組みを含める。
3. CLI：準備済みのイメージから作業用VMを起動し、同期、コマンド実行、状態表示、一時停止・再開・終了を行う。

初期設定・イメージ更新と、作業ごとのVM起動・終了を区別する。接続方式は2026年10月20日にWebSocket経由のOpenSSHを採用し、VM内では接続ごとのsshdを起動する。

## 確認した外部仕様

2026年10月19日にAWS公式資料を確認した。

- MicroVMイメージはDockerfileとアプリケーション資材をまとめたzipをS3へ置いて作成する。
- AWS CDKのTypeScript APIに `aws_lambda.CfnMicrovmImage` があり、`AWS::Lambda::MicrovmImage` を定義できる。これにより、CDKによるイメージ定義を検討できる。
- 作業用MicroVMは `RunMicrovm` APIでイメージから起動できる。
- イメージビルドのロール、実行時のロール、利用者の管理操作権限は役割が異なる。詳細なIAMポリシーと接続方式は実装時に確認する。

初回調査時点では、対象AWSアカウントでの利用可否、デプロイ、VM起動は未検証だった。その後のcdkdによるAWS基盤の作成とVM起動の実証結果は、[MicroVM基盤の設計と検証](../decisions/microvm-foundation.md)に記録している。2026年10月20日にBun CLIの初版を実装し、起動・一覧・状態・接続確認・終了の5操作を実機で確認した。[CLIの設計と検証](../decisions/bun-microvm-cli.md)に認証方式別の検証範囲と結果を記録する。

## 未決定事項と次の作業

CLIはTypeScript/BunとSDK標準認証で実装した。WebSocket経由のSSH、rsync/scpの明示転送、名前付きセッション、VS Code接続、CLIから開くXfce/Chromiumデスクトップまで実装・実AWS検証済み。実証に使ったAWSアカウント・リージョンを製品の固定条件とせず、各利用者のアカウント・リージョンで必要な権限とクォータを確認できる設計にする。「1プロジェクトをVMへ送り、コマンドを実行し、変更されたファイルを手元へ回収する」経路は明示的なSSH・転送で確認した。

この目標は、[中心となる利用体験を優先する原則](../principles/experience-first.md)に沿っている。同じプロジェクトへ複数の名前付きセッションを作れる。継続同期、競合解決、Suspend/Resumeは今後の設計対象。

## 名前付きセッションの合意

2026年10月20日、ユーザーは名前・プロジェクト・VMとSSH設定の保持、一覧・再接続・終了を実装する方針を承認した。CLIやVS Codeを閉じても設定を保持し、待機用sleepは不要にする。1セッションは1台のVM、同一プロジェクトに複数のセッションを許す。project指定による自動転送、期限切れ後の自動再作成は行わない。実装と検証の詳細は名前付きセッションの判断記録に置く。

## デスクトップの追加

2026年10月20日、ユーザーは最初の引き継ぎにあったデスクトップとブラウザの利用を次の機能として依頼した。名前付きセッションから手元のブラウザにnoVNCを開き、VMのXfceとChromiumを操作する。CLI中心の方針を保ち、既存SSH経路を再利用する。新しいイメージ6.0の実AWSで初回接続とVM内localhostのページ操作を確認した。GUIは画面切断後も生存し、VM終了で失われる。詳細と制限は[デスクトップの設計](../decisions/desktop-over-ssh.md)を参照する。

# Related Concepts
- [名前付きセッションを端末のSQLiteで管理する](../decisions/named-sessions.md): 承認された名前付きセッション管理を具体化した実装契約と未対応範囲。
