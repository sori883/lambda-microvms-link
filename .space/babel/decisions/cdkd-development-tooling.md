---
type: decision
title: 開発用CDKツールとしてcdkdを導入する
description: cdkdとCDKを固定版で利用し、Bunを標準実行環境とする方針、ローカル検証とAWS差分確認の結果、公式動作要件との境界を記録する。
governance: context
tags: 
  - cdkd
  - CDK
  - MicroVM
  - 開発環境
code_refs: 
  - package.json
  - bun.lock
  - mise.toml
  - scripts/verify-cdkd.mjs
  - .agents/skills/cdkd/SKILL.md
  - bunfig.toml
  - AGENTS.md
sources: 
  - resource: https://github.com/go-to-k/cdkd/tree/f71b30f075316d85c53eac95e2ea966e0278f0f5
    title: cdkdの確認対象コミット
  - resource: .space/tasks/cdkd-feasibility/task.md
    title: cdkdの導入とMicroVM基盤への適合確認
  - resource: scripts/verify-cdkd.mjs
    title: ローカル互換性確認
  - resource: "https://bun.sh/docs/runtime/bunfig#run-bun-auto-alias-node-to-bun"
    title: Bunのrun.bun設定
generated: 
  by: agent:codex
  at: 2026-10-19T15:45:36.772Z
---
# 開発用CDKツールとしてcdkdを導入する

## 判断と対象

2026年10月19日、ユーザーは後藤健太氏のCDK関連ツールと付属スキルの導入、およびMicroVM基盤を開発できるかの検討を依頼した。公開元を go-to-k/cdkd（CDK Direct）と特定し、開発・テスト用の導入とローカル適合確認を行った。

[CLI単独のMicroVM開発環境という範囲](../knowledge/microvm-development-environment-scope.md)を維持する。cdkdによる本番運用、CloudFormation管理リソースからの移行は決定していない。

## 導入内容

- `@go-to-k/cdkd@0.301.11`、`aws-cdk-lib@2.273.0`、`constructs@10.8.1` をプロジェクトの開発依存に固定した。Bunのlockfileを保持する。
- 手元の実行環境とパッケージ管理はBun 1.4.2を標準とし、miseとpackageManagerで固定する。初回導入時はNode.js 24.15.0も使っていたが、2026年10月20日のユーザー指示でBunへ統一した。
- エンドユーザー向けスキルを `.agents/skills/cdkd/SKILL.md` に導入した。出典は go-to-k/cdkd のコミット `f71b30f075316d85c53eac95e2ea966e0278f0f5`、パス `plugins/cdkd-skills/skills/cdkd/SKILL.md`。原本との一致を確認し、改変していない。
- 呼び出しは `mise exec -- bun run cdkd --version`。ローカル検証は `mise exec -- bun run verify:cdkd`。

## 採用の根拠と確認範囲

公開版cdkdの起動とヘルプ表示に成功した。CDKの `CfnMicrovmImage` を使って、IAM Role、S3 Bucket、Logs LogGroup、MicroVMイメージを含む検証用assemblyを生成し、公開版cdkdの `synth --app <assembly> --strict` で読取成功を確認した。イメージARNの出力も保持された。

公開ソースと配布パッケージにMicroVMイメージ専用providerがあり、作成・取得・更新・削除とビルド完了待ちの処理が存在する。以上から、開発用CDK基盤の実装に着手できると判断した。

この初回ローカル評価だけではAWSへのデプロイ成功を示していなかった。その後の実機デプロイ、イメージビルド、VM起動・接続の結果は[MicroVM基盤の設計と検証](microvm-foundation.md)を参照する。検証用テンプレートの値は仮で、実機デプロイに使用しない。

## Bunを標準とする実行環境

2026年10月20日、ユーザーはcdkdをBunで動かし、Bunを標準とするよう依頼した。固定したcdkdとCDKの版は変更せず、既存のローカル実行経路をBunへ移した。

- `bunfig.toml` の `run.bun = true` で、cdkdとTypeScriptコンパイラーのNode.js指定もBunに解決する。`bun run cdkd` などの利用者向け入口は維持する。
- テストは `bun test`、互換性確認は `bun scripts/verify-cdkd.mjs` で実行する。テスト探索は `tests/` に限定し、導入済みスキルの内部テストを製品テストへ混ぜない。
- `mise.toml` から手元のNode.js指定を外し、packageManagerを `bun@1.4.2`、enginesを `bun >=1.4.2` とする。依存パッケージは更新していない。
- VMのコンテナは実機で検証済みのNode.js 24 Alpineを引き続き使う。手元のHTTPテストはBunで同じエントリーポイントを実行するため、コンテナ本来のランタイムの検証とは区別する。

Node.jsが起動されたら失敗するPATHを用意して、frozen lockfileによる依存確認、型検査、既存3テスト、cdkd互換性確認、実スタックのsynth、cdkdのバージョン表示とstrict synthがすべて成功した。通常のsynthのテンプレートと資材manifestのSHA-256は移行前と一致した。cdkd経由のsynthだけが追加する構成パスのMetadataは実行入口の違いであり、リソース定義の変更ではない。

Bunからプロファイル `AdministratorAccess-242201303782`、リージョン `ap-northeast-1` で `diff MicrovmFoundation --fail-on=any-change` を実行し、終了コード0・差分0件を確認した。BunによるAWS再デプロイは未実施。

公開パッケージcdkd 0.301.11のenginesはNode.js 22.12以上であり、Bunの公式サポートを意味する変更ではない。本プロジェクトの固定版で通した経路を確認範囲とし、更新時にも型検査・テスト・合成とAWS差分を検証する。

## 実装時に守る境界

- 公開元はcdkdを開発・テスト向けとしている。今回もその用途で使用する。
- cdkdはAWS APIを直接操作するため、実行者に対象リソースの操作権限が必要。CDK bootstrapのデプロイロールだけで足りるとは扱わない。
- cdkd bootstrapは状態保存用S3と資材ストレージを作るAWS変更であり、対象アカウント・リージョンを確定してから実施する。
- 最初の実機確認ではMicroVMイメージのビルド完了を待つ。`--no-wait` の成功をイメージ利用可能の証拠にしない。
- 付属スキルのsynth selectorに関する記述と同版CLIのヘルプには差がある。今回の確認はselectorを使わず、矛盾に依存していない。実操作では導入版のヘルプ・ソースを照合する。

作業記録、根拠、次の実装単位は `.space/tasks/cdkd-feasibility/task.md` にある。
