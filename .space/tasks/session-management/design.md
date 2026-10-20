# 採用した構成

2026-10-20。独立候補A（セッション別ファイルとjournal）、B（SQLiteと接続資材）を比較し、Bを採用した。親と独立比較担当cli_compareの結論は一致。SQLiteはBun標準機能で、常駐プロセスを増やさず名前の一意性・起動送信権・VM所属の更新を原子的に扱える。Aのowner lockはPID再利用、owner情報確定前の停止、stale lock解除の独自実装を必要とするため見送った。

Aの不変session UUIDをSSH aliasへ使う方針と、CLI移動時にVM/pinを維持してlauncherだけ修復する方針を採用する。AWSの状態と手元の観測値は分け、通常の一覧でAWSを照合する。Run前に送信意図を確定し、結果不明時は自動再送しない。利用者がIDを明示するrecoverで整合性を検証して紐付ける。AWSのclientToken保持時間は公式APIに記載がなく、無期限再送の安全性は仮定しない。

AWS操作は標準credential chainで解決した同じ資格情報をSTSとMicroVM APIへ渡し、保存account/regionとの一致を確認する。資格情報とshell tokenは保存しない。SSH資材はprivateな世代別directoryに完成後、SQLiteの短いtransactionで公開する。終了意図に反する新規公開を拒否し、終了確認後に接続資材だけを消す。使用中のVS Code user-data-dirは消さない。

Remote-SSH0.128.0のremote.SSH.configFileはapplication scopeである。セッション専用user-data-dirへその設定を置き、通常VS Code設定や~/.ssh/configを変更せず起動する。環境変数資格情報の更新は既存GUIプロセスへ反映されないため、必要なら専用窓を終了し再起動する。拡張の認識と実接続は実証する。

## 実装分担と検証

- cli_design_b: session-store.ts / sessions.ts / session-store.test.ts。短いSQLite transaction、同名競合、未知Run、復旧、終了と掃除。
- cli_design_a: session-ssh.ts / ssh.ts / session-ssh.test.ts。永続資材、pin、UUID alias、VS Code専用設定、従来SSH互換。
- 親: CLI、AWS認証と起動分離、依存、CLI実プロセステスト、実AWS/VS Code検証、READMEとOKF。
- cli_compare: 実装後の独立レビュー。作成担当の自己検証と区別する。

同じprojectの複数session、同名並行create、Run未知結果の再送禁止、account不一致拒否、認証失敗のUNKNOWN、別プロセスからのSSH再接続、終了後鍵削除を検証する。AWSは検証専用VMのみを作成して終了確認まで行う。ユーザー既存VMは対象外。
