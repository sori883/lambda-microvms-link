# 名前付きセッション管理

2026-10-20。ユーザーが名前付き管理・一覧・再接続・SSH設定保持の初版を承認。Bun CLIへの実装、検証、独立レビュー、使い方の更新まで行う。Suspend/Resume、自動同期、クラウドの管理サービス追加、コミット/公開は対象外。

## 完了条件

- S1: 名前と手元のプロジェクトをVM1台に対応付け、プロセスを終了しても保存される。同じプロジェクトに複数セッションを持てる。
- S2: 一覧・状態はAWSの実態と照合し、接続不能や認証失敗を稼働中と偽らない。account/regionの取り違えで操作しない。
- S3: SSHとVS Codeから、待機用sleepを必要とせず名前で再接続できる。既存のSSH/VS Code設定を壊さない。
- S4: 同時作成・途中失敗・起動結果不明でVMを重複作成せず、復旧手順が分かる。
- S5: 終了を確認して接続用の秘密を片付ける。CLI/VS Codeの終了だけではVMを終了しない。AWS資格情報と認証トークンは永続保存しない。
- S6: 既存VM ID指定CLIの互換性を保ち、ローカル検証と自分が作成したAWS VMで一連の操作を確認する。ユーザーが使用中のVMには変更/終了を行わない。

## 工程と担当

中規模。既存CLI/SSHの設計・24テスト・AWS image3.0の実証を再利用する。新しい永続データと認証境界があるため、独立候補A/B、独立比較、実装後のレビューを行う。設計候補はcli_design_a/bが各ファイルのみ所有。統合・CLI・AWS操作・文書は親が所有。比較の後に実装単位の所有を割り当てる。既存の大量の未追跡ファイルとREADME変更を保持する。

ルール全件0件、原則23件のdescriptionを前ターンで確認。適用はexperience-first、model-the-domain、foundational-thinking、make-operations-idempotent、separate-before-serializing-shared-state、type-system-discipline、boundary-discipline、prove-it-works。src/**の理由はdecisions/bun-microvm-cliとdecisions/ssh-over-websocketを確認。CLIが明示VM IDだけを使う従来の選択は初版の範囲によるもので、今回の永続管理追加を禁止しない。

## 着手時の状況

現在はstart/list/status/check/stopとssh/with-ssh。接続ごとの鍵/configはwith-sshの子終了で削除する。ユーザーはwith-sshでsleepを保持し、VS Code Remote-SSHから/workspaceを開き、転送したmain.mjsの実行まで本人確認済み。一時SSH設定のread待機は終了してしまい、sleepへ案内を訂正した。

セッションの秘密鍵/host pinの寿命、作成journal、GUIの資格情報取得、VS CodeへのSSH設定の渡し方、既存ユーザー設定を変更せず起動する方法を設計・検証する。手元VS Code1.141.0、Remote-SSH0.128.0が導入済み。

## 完了結果

[設計と分担](design.md)のB案を実装し、S1〜S6を確認した。新規のsession-store、sessions、session-aws、session-sshで保存・操作・認証・接続設定の責務を分けた。既存のVM ID指定操作は維持し、名前付きcreate/list/status/ssh/with-ssh/code/stop/recoverを追加した。READMEに操作と復旧手順を記載した。

- 型検査、46テスト成功、任意Docker1件skip、単体実行ファイルのビルド成功。
- 実CLIの別プロセス、同時作成、Run待機中の強制終了・stop、明示復旧、認証先不一致、失敗時UNKNOWNを確認した。
- 独立レビューで資格情報解決の期限と認証前の終了意図書込みを修正し、再確認した。修正必須の残件なし。[レビュー記録](review.md)を参照。
- 実AWSで名前付き起動、一覧、別CLIからのSSH再接続、VS Code接続、停止、SSH鍵削除を確認。通常のSSH・VS Code設定のハッシュは不変。
- イメージにcurlを追加し、cdkd full-waitで4.0へ更新した。更新2件・追加削除0件、最新run SUCCEEDED、再diff0。追加インストールしていない4.0のVMでも、VS Code Serverの初回導入と `/workspace` 接続が成功した。
- 作成した検証VM2台はTERMINATEDを確認し、専用の検証用VS Codeウィンドウも終了した。利用者が作成したVMを操作していない。

証拠は[永続設定の実AWS検証](evidence/aws-smoke.json)、[イメージ4.0の検証](evidence/fresh-smoke.json)、[デプロイ結果](evidence/cdkd-deploy.log)、[最終差分](evidence/cdkd-final-diff.log)。自動テストはtests/session-cli.test.ts、session-store.test.ts、session-ssh.test.tsと既存テスト群。対象はmacOS ARM64、SSO profile AdministratorAccess-242201303782、ap-northeast-1。LinuxホストのGUI、最小IAM主体、長時間再接続、SSO以外の実AWS環境は未検証。

SQLiteのschemaは1。終了した名前の再利用、台帳の端末間共有、自動同期、Suspend/Resumeは実装していない。`--project` は関連付けだけで、転送は引き続き明示的なrsync/scpを使う。

OKFにはdecisions/named-sessionsを作成し、既存のCLI・SSH・基盤・目的の4文書を更新して相互の関係を追加した。strict/drift検証はエラー・警告・リンク切れ・staleが0件。既存の孤立した共通原則17件は残り、bundle全体のgateは未通過。今回の文書に孤立はなく、無関係な原則を検証通過のためだけに関連付けていない。[検証結果](evidence/okf-validation.json)に記録した。
