# MicroVMイメージのCDK基盤

更新日: 2026-10-19。担当: Codex。進行状態: 完了。成果判定: コード、ローカル検証、AWS上のデプロイと起動・認証付き応答の確認に合格。

## 目的と範囲

以下のローカル限定範囲は初回実装時の指定。後続のユーザー依頼「SSOでログインできるようにしたので、AdministratorAccess-242201303782でやってみて」により、AWSデプロイと一時VMによる確認へ範囲を拡張した。既存の実装・設計・レビューを再利用し、不要な再実装はしない。

CLI向け開発環境の最初の単位として、イメージ資材、ビルド用IAM権限、ログ、MicroVMイメージをCDKで定義する。利用者は「今回はコードとローカル検証まで」と指定した。AWSへの認証・bootstrap・デプロイ・VM起動は実施しない。Web対応と製品CLIは今回の対象外。

前段のツール導入は [cdkd適合確認](../cdkd-feasibility/task.md) を再利用する。cdkd 0.301.11、CDK 2.273.0 の同じ版を使う。新規の実装のため、互換性を維持すべき既存アプリはない。共通原則と既存のCLI限定の要件を参照し、infra/ と image/ のcode_refs検索は該当なし。

## 初回のローカル実装の工程と受け入れ条件

標準規模。IAMを扱うため独立レビューを行う。設計候補A（単一スタックとCDK Asset）とB（専用バケット・手動アップロード・イメージスタック）を別担当が並行で検討し、親が実装と記録を所有する。候補担当は読み取り専用。

| 条件 | 確認方法 | 結果 |
| --- | --- | --- |
| C1: 実際の資材からCDKテンプレートとasset manifestを生成できる | 実装したアプリの合成、型検査、cdkdでassemblyを読む | 合格 |
| C2: ビルド権限は対象資材とログに限定され、ポリシー設定後にイメージを作る | 合成物のIAM・依存関係検査、独立レビュー | 合格。実AWSの権限伝播は未確認 |
| C3: イメージのヘルス応答・ready/validate hooksが動く | 実プロセスへのHTTP要求、ARM64コンテナ実行 | 合格。スナップショット復元は未確認 |
| C4: 資材変更がイメージ更新として検出される | 同一資材の安定したキーと、変更した資材のキー・URIの差を検証 | 合格。実AWSでの新version作成は未確認 |
| C5: AWSを変更せず検証でき、実機でしか確認できない点が分かる | 認証情報なしの合成、READMEの手順と結果照合 | 合格 |

## 計画と所有範囲

1. 構成案を比較し、資材・権限・ビルドの境界を決める。
2. 親がinfra/、image/、tests/、scripts/、package.json、READMEを実装する。単一の資材契約と権限を一緒に検証するため実装は一人が所有する。
3. 型検査、合成、HTTP応答、資材更新をローカルで確認する。Docker利用可否は独立して調べる。
4. 読み取り専用の独立レビューでIAM、依存関係、更新・失敗時の扱いを確認し、必要な修正を反映する。
5. 確定した設計と検証の限界をOKFへ保存し、利用手順とともに引き渡す。

作業記録と全体判定は親がこの文書で管理する。デプロイの失敗・復旧は手順として記載し、AWS上での確認済み事項とはしない。

## 設計比較と採用

候補Aをfoundation_design_a、候補Bをfoundation_design_bが同じ要件から独立に検討した。どちらも読み取り専用で、他候補を参照せず親へ報告した。

- A: `image/` → CDK Asset → cdkd資材保管先 → 単一のMicrovmFoundationスタック。資材の内容ハッシュとアップロードをCDK/cdkdに任せ、IAMの対象オブジェクトも同じAssetから導く。共有bootstrap保管先とURI/ARN書換えへの依存が不利益。
- B: ArtifactStackで専用S3を作成 → 独自処理でZIP作成・SHA256キーへアップロード → URIをImageStackに渡す。保管先は明確になるが、二つのデプロイ、ハッシュ・URI・対象環境の受け渡し、未使用資材の管理が増える。

比較基準は初回利用の簡単さ、権限の狭さ、更新検出の正しさ、手作業で整合させる状態の数、ローカル検証のしやすさ。候補作成に参加しなかったfoundation_compareと親が評価し、双方Aを採用と判断した。Bの構造は取り込まない。独立した成果物配布や複数アカウント間共有が必要になった場合の代替として残す。

採用した構成の入力はimage/内のDockerfileとserver.mjs、および任意のbaseImageVersion。出力はImageArnとBuildLogGroupName。ビルドロールは対象ZIP一個のGetObjectと専用ロググループ内のCreateLogStream・PutLogEventsのみを持つ。ロール内のinline policyにより、ロール完成後という依存に権限設定を含める。ロググループは保持、ログデータは7日保持とする。

CDK 2.273のL1はAPIの任意項目を必須とするためCfnResourceを使う。合成時にも同じCloudFormationのF3003警告が出たので、このリソースの当該ルールだけを理由付きで承認した。AWS APIで必須のName・BaseImageArn・BuildRoleArn・CodeArtifactは定義する。CloudFormation経由のデプロイをサポートしたという判定にはしない。

失敗時はcdkdの状態・イベントとビルドログを調べてから再試行する。イメージ名は資材変更で変えず、URIの変化で新versionをビルドする。初回のAWS確認では完了待ちを使う。削除後の同名ロググループ再利用は保持された実物を確認して扱いを決める。

## 初回のローカル実装・検証とレビュー

- `mise exec -- bun run verify`: 型検査と3テストが成功。実テンプレートの権限・依存、秘密値を含む.envの除外、内容変更によるURIとIAMの変化、ヘルスとフックへの実HTTP要求を確認した。
- `mise exec -- bun run synth`: cdk.outに実テンプレートと資材を生成。認証情報不要、警告なし。以前の仮資材による適合確認とは分けている。
- `mise exec -- bun install --frozen-lockfile --ignore-scripts`: 成功。固定依存に変更なし。
- Docker 28.4.0でARM64コンテナをビルドし、非rootユーザーで実行。3エンドポイントのHTTP 200と本文を確認した。[実行証拠](evidence/container.json)にイメージID、基底イメージdigest、結果を保存した。テスト用コンテナは停止・削除済み。
- Dockerの最初の公開イメージ取得はcredential helperで応答がなく中断した。一時的な空のDocker設定と既存daemonへの接続で公開イメージを取得し、ビルド成功。通常のDocker設定や認証情報は変更していない。
- `git diff --check`: 成功。既存の未コミット変更は保持。コミット・pushは未実施。

interrogateによる2担当の読み取り専用レビューを実施。同じモデルの別担当であり、モデルの多様性を意味しない。foundation_reviewは候補作成・比較・実装に未参加、foundation_compareは候補比較のみ参加し実装には未参加。両者が型検査・3テストを独立に実行し、固定版cdkdの資材書換え、IAM設定順、ログARN、APIマッピングを確認した。必須修正の指摘はなかった。レビュー中にNodeの最低版を24.15.0へ合わせ、最終版で確認した。

AWSでのbootstrap、アップロード、サービスによるイメージビルド、スナップショット復元、VM起動と認証付きアクセスは未実施。ユーザー指定の終了地点からは除外する。製品CLIやコマンド実行は実装していない。

## 知識保存

採用構成・権限境界・CDKスキーマ差・検証範囲を [decisions/microvm-foundation](../../babel/decisions/microvm-foundation.md) に保存した。既存のツール導入判断とCLI限定要件へ関連付け、CLIで読み返した。strict/drift検証はerrors・warnings・broken_links・staleが0件。bundle全体のgateは既存の孤立原則22件でfalseのままで、新規文書の不備はない。初回保存でタスクへのMarkdownリンクがbundle内conceptとして扱われたため、sourcesと本文のパス参照に修正し、リンク切れがないことを再確認した。

## 文書の関連付けに関する説明

既存の共通原則22件が他のconceptへのリンクを持たず、OKF検証で孤立文書として報告されている。リンク切れ、コードの不具合、開発の前提条件ではない。今回の実装範囲外であり、意味のないリンク追加で検証を通すことはしない。

## AWS実機確認（2026-10-19）

対象: プロファイルAdministratorAccess-242201303782、STSで確認したアカウント242201303782、プロファイル設定のap-northeast-1、開発用スタックMicrovmFoundation。SSO認証成功、ListManagedMicrovmImagesで東京のal2023-1を取得できた。

既存リソースとの衝突を確認し、必要なbootstrap、diffとdry-run、完了待ちのdeployを順に実施する。確認用VMは最大存続時間を短く指定して起動し、トークン付きhealth応答を確認した後に終了する。トークンと認証情報は出力・保存しない。イメージとCDK管理リソースは次の開発に使える状態で残す。

| 条件 | 結果 |
| --- | --- |
| A1: 対象環境の特定と衝突確認 | 合格。STS、AdministratorAccessの付与、CFN管理対象なし、同名イメージ・ログなしを確認 |
| A2: bootstrapと3リソースの作成完了 | 合格。bootstrap、diff、dry-run、full-waitのdeployが成功 |
| A3: イメージとそのversionのビルド成功 | 合格。CREATED、version 1.0がSUCCESSFUL / ACTIVE |
| A4: VMの認証付きhealthが200、未認証では拒否 | 合格。未認証403、8080限定トークン付き200とstatus:ok |
| A5: 検証VMの終了を確認 | 合格。GetMicrovmでTERMINATEDを確認 |

実行時のソースは前回ローカル検証済みのまま。資材ハッシュは `7ebe77805d5eb6cba96deb20c65facdb2d596cad41699205a5da913e49b48771`。コード修正なしで実機に通ったため、同じローカル検証や独立レビューは繰り返していない。

- bootstrap: 状態保存S3、資材S3、コンテナ資材ECRを作成。名前はREADMEに記載。状態・資材S3の暗号化と外部アクセス拒否、資材S3の公開アクセス遮断を設定した。
- `cdkd diff MicrovmFoundation --fail-on=destructive`: 3件作成、更新・削除0件。`deploy --dry-run`も同じ結果。
- `cdkd deploy MicrovmFoundation --full-wait`: 116.08秒、3件作成で成功。ImageArnとBuildLogGroupNameを取得。
- `cdkd state show`: 3件の管理状態、ロック解除、資材URIとIAMの単一オブジェクトARNがcdkd資材バケットを参照することを確認。
- デプロイ後の`cdkd diff --fail-on=any-change`: 差分なし、終了コード0。
- [AWSスモーク検証の証拠](evidence/aws-smoke.json): VM起動から認証付き応答、終了まで記録。SDKを利用した一時的な実行で、製品CLIは追加していない。最大存続300秒、トークン有効期限5分・8080限定。トークンはメモリ内のみで扱った。

イメージARNは `arn:aws:lambda:ap-northeast-1:242201303782:microvm-image:lambda-microvms-link-dev`。基底イメージはal2023-1のversion 1.0。検証VM `microvm-20ba744a-2809-3ddc-a558-df9e84ed1dfb` は2026-10-19 23:18:20 JSTに終了した。イメージ・ロール・ログ・bootstrap資材は次の開発用に保持する。

イメージ更新、ファイル同期、コマンド実行、複数VM、サスペンド／レジュームは今回の確認範囲外。SSOでの認証と初回イメージ作成・VM起動に関する障害はなかった。
