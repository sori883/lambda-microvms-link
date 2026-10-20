# cdkdの導入とMicroVM基盤への適合確認

## 依頼と範囲

2026年10月19日、ユーザーは後藤健太氏のCDK関連ツールと付属スキルを導入し、MicroVM基盤を開発できるかの検討を依頼した。対象は go-to-k/cdkd（CDK Direct）と特定した。

導入、公開ソースの対応範囲調査、ローカルでのCDKテンプレート生成と互換性確認までを行う。AWSへのbootstrap・デプロイ・VM起動は今回の実行範囲に含めない。CLI単独の製品方針を維持する。

## 完了条件

- A1: cdkdの公開版を固定して導入し、バージョンとヘルプを実行できる。
- A2: エンドユーザー向けcdkdスキルをプロジェクトに導入し、公開元と内容の一致を確認できる。
- A3: IAM、S3、Logs、MicroVMイメージの対応を調べ、公開パッケージでCDK定義をローカル生成できる。
- A4: ローカルで確かめた範囲とAWS実機未検証の範囲を分け、次の実装単位を示せる。

## 工程と進行

標準規模の導入・調査。調査と導入、検証と報告をそれぞれ統合する。既存のCLI方針とAWS環境・イメージ・CLIの区分を再利用し、今回新たな製品アーキテクチャは決定しない。認証やデプロイの実装は追加しないため、独立した設計探索・独立レビューは省略する。

1. 公開元と必要版の確認: 完了。
2. cdkdと付属スキルの導入: 完了。
3. 公開パッケージによる互換性確認: 完了。
4. 結果の記録: 完了。今回の導入・適合確認を完了として報告する。

## 根拠と版

- cdkd: npm `@go-to-k/cdkd@0.301.11`。
- CDK: npm `aws-cdk-lib@2.273.0`。
- constructs: npm `constructs@10.8.1`。
- 公開ソース・スキル: https://github.com/go-to-k/cdkd/tree/f71b30f075316d85c53eac95e2ea966e0278f0f5
- スキル原本: `plugins/cdkd-skills/skills/cdkd/SKILL.md`。
- 本体はこのプロジェクトの開発依存、スキルは `.agents/skills/cdkd/` に導入する。

## 現在の判定

開発用のCDK基盤を実装するためのツールとして利用可能と判断する。A1〜A4は今回の確認範囲で満たした。AWS実機のデプロイやMicroVM起動は未検証で、製品の完成判定ではない。

## 検証結果

| 条件 | 実際に確認したこと | 結果 |
| --- | --- | --- |
| A1 | `mise exec -- bun run cdkd --version` と `--help` | バージョン `0.301.11` とコマンド一覧を取得。終了コード0 |
| A2 | skill-installerで指定コミットから導入し、原本と `cmp` で照合 | `.agents/skills/cdkd/SKILL.md` が一致。終了コード0 |
| A3 | `mise exec -- bun run verify:cdkd` | CDKからIAM Role、S3 Bucket、Logs LogGroup、MicrovmImageの4種類を生成し、公開版cdkdの `synth --app <assembly> --strict` で読取成功。ImageArn出力も存在。終了コード0 |
| A4 | 公開ソースと上記結果を照合 | 必要なリソースに対応。以下のAWS実機未確認事項を分離 |

検証スクリプトは `scripts/verify-cdkd.mjs`。`result: passed`、`awsDeploymentTested: false` を出力する。AWSコンテキストの問い合わせやマクロを含まないCDK assemblyを生成し、cdkdにはその生成済みassemblyを渡す。子プロセスのAWS設定ファイルは空にし、AWS/CDK関連の環境変数を引き継がない。仮の資材を使うため、検証用テンプレートはデプロイしない。生成物は確認後に削除する。

これはCDKからcdkdへのテンプレート受け渡しの確認であり、AWS側でのプロパティ受理、IAMポリシーの十分性、イメージビルドの成功を検証するものではない。

## 公開元で確認した対応

- [supported-resources.md](https://github.com/go-to-k/cdkd/blob/f71b30f075316d85c53eac95e2ea966e0278f0f5/docs/supported-resources.md)にIAM、S3、Logs、`AWS::Lambda::MicrovmImage` の対応記載がある。
- [専用provider](https://github.com/go-to-k/cdkd/blob/f71b30f075316d85c53eac95e2ea966e0278f0f5/src/provisioning/providers/lambda-microvm-image-provider.ts)にMicroVMイメージの作成・取得・更新・削除、ビルド完了待ち、CloudFormation形式からSDK形式への変換が実装されている。インストール済みnpmパッケージにも専用providerとSDKコマンド参照が存在する。
- [統合テスト例](https://github.com/go-to-k/cdkd/tree/f71b30f075316d85c53eac95e2ea966e0278f0f5/tests/integration/lambda-microvm-image)がある。本作業ではAWSを使うこのテストを実行していない。
- 当プロジェクトに導入したCDK 2.273.0には `CfnMicrovmImage` があり、検証でも実際に使用した。公開元の統合テストにある「L1が未提供」という説明は、そのテストの使用版に関する情報として扱う。

## 採用時の条件

- cdkdは公開元が開発・テスト向けとしている。今回は開発基盤に使用する。
- cdkdはCloudFormationの実行ロールではなく、呼び出し側の権限でAWS APIを操作する。デプロイ担当の権限設計に反映する。
- cdkdのbootstrapは状態保存用S3と資材用ストレージを作る。実施時はアカウント・リージョンを明示する。
- MicroVMイメージのビルドは非同期。最初の実機検証は完了待ちを行い、`--no-wait` を使わない。
- 付属スキルは原本のまま導入した。現在のスキルには `synth` のstack selectorを受け付けない旨の記述があるが、同版のCLIヘルプと実装は受け付ける。今回の確認はselectorを使わず、矛盾する操作に依存していない。

## 次の実装単位

1. 開発用AWSプロファイル・アカウント・リージョンを確定し、MicroVMの利用可否と権限を読み取りで確認する。
2. Dockerfileと最小の起動確認プログラム、資材のS3配置、ビルド用ロール、ログ、MicroVMイメージをCDKで定義する。
3. cdkdの差分・実行計画を確認し、対象AWS環境へbootstrapとデプロイを行う。
4. イメージビルドの完了を確認し、VM起動と認証付きの応答まで実証する。

今回の依頼はツール導入と開発可能性の検討まで。上記の本体実装・AWS変更は未着手。

## 知識の保存と残件

`.space/babel/decisions/cdkd-development-tooling.md` に判断と根拠を保存し、読み返しを完了した。OKFのstrict/drift検証は形式エラー・警告・リンク切れが0件だったが、導入前から存在する22件のprincipleの孤立により全体gateは未通過。今回の文書は既存のスコープ文書へ関連付け済み。全体検証を通すためだけの無関係な関連追加は行っていない。
