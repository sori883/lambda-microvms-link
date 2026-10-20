---
status: stable
governance: context
tags: 
  - MicroVM
  - CLI
  - セッション
  - SQLite
  - SSH
  - VS Code
code_refs: 
  - src/session-*.ts
  - src/sessions.ts
  - src/cli.ts
  - src/microvms.ts
  - tests/session-*.test.ts
  - image/Dockerfile
  - README.md
  - package.json
sources: 
  - resource: .space/tasks/session-management/task.md
    title: 名前付きセッション管理の設計と検証
  - resource: .space/tasks/session-management/review.md
    title: 独立レビューと実機修正
  - resource: .space/tasks/session-management/evidence/aws-smoke.json
    title: 永続SSHとVS Codeの実AWS検証
  - resource: .space/tasks/session-management/evidence/fresh-smoke.json
    title: イメージ4.0の初回接続と終了
  - resource: https://code.visualstudio.com/docs/remote/linux
    title: VS Code Remote-SSH Linux前提
type: decision
title: 名前付きセッションを端末のSQLiteで管理する
description: 名前とVMの対応、起動結果不明時の復旧、AWS認証先の照合、永続SSHとVS Code設定の寿命、および実機検証を記録する。
generated: 
  by: agent:codex
  at: 2026-10-20T03:36:42.007Z
---
# 名前付きセッションを端末のSQLiteで管理する

2026年10月20日、名前、プロジェクト、VM、接続設定を保持する初版をユーザーが承認した。1セッションを1台のVMに対応付け、同じプロジェクトへ複数の名前を作れる。CLIやVS Codeを閉じてもVMは終了せず、名前で再接続できる。自動同期、Suspend/Resume、クラウド側の管理サービスは追加しない。

## 採用した構造

独立候補AのJSONファイルとロック、候補BのSQLite台帳を比較し、Bを採用した。名前の予約、起動要求の記録、終了意図、SSH設定の公開を短いトランザクションにまとめ、プロセスの強制終了後にも判断の根拠を残せるためである。比較担当は候補の作成に参加していない。

src/session-store.tsが保存、src/sessions.tsが操作と復旧、src/session-aws.tsがAWS認証先の照合、src/session-ssh.tsが接続設定の寿命を所有する。台帳は既定~/.mvm/sessions.sqlite、MVM_HOMEで変更可能。ディレクトリ0700、ファイル0600、schema version1、WAL、busy timeout2秒を使う。ネットワークや子プロセスの完了までトランザクションを保持しない。

登録した名前とaccount/region/VMの組み合わせは一意。終了後も履歴を残し、名前の再利用とforgetは初版に含めない。projectは実パスの記録だけであり、アップロードやマウントではない。実行中という事実の正本はAWSで、一覧や状態は照合する。認証や通信が失敗した場合はUNKNOWNとエラーを返し、保存したRUNNINGを現在の状態として見せない。NotFoundだけで終了と判定しない。

## 起動と復旧

起動時にイメージARNと最新の有効版を固定し、Runの前に入力とclientTokenを保存する。preparedからrequest-unknownへ遷移した一つのプロセスだけがRunを送る。返却されたVM IDは待機前に保存し、中断済みでも失わない。Run中のstopは終了意図を保持し、後からIDが判明したcreateが終了処理へ進む。

Run応答を失った場合、自動再送しない。AWSの冪等性トークン保持期間を超えた重複防止は保証できないためである。同じ名前のcreateは復旧情報を返し、session recoverで明示したIDを確認する。照合するのはaccount/region、イメージと版、存続時間、requestedAtの1分前から1時間後までの開始時刻、他セッションへの未登録。候補を自動選択せず、同条件のVMを完全に識別する仕組みとは扱わない。

## 認証と終了意図

認証はSDK標準credential chain。明示profile、保存profile、AWS_PROFILEの順に参照し、保存したregionを使う。取得した資格情報の同じスナップショットでSTSとMicroVM APIを呼び、保存accountと一致させる。資格情報、セッショントークン、WebSocketトークンを保存しない。

stopは未確定IDを含め、認証先の照合と中断確認を済ませてからdesired=terminatedを書く。独立レビューで、照合前に書くと拒否された別accountの操作が進行中createにVMを終了させる問題を発見し修正した。資格情報解決にも期限を適用し、返らないcredential_processを待ってCLIが残り続けないようにする。

## SSHとVS Code

SSHは既存のAWS managed shell経由のOpenSSHを再利用する。セッションUUIDと世代UUIDで秘密鍵・公開鍵・known_hosts・configを分け、完成後に台帳へ比較更新で公開する。同時準備の敗者は自分の未公開ディレクトリだけを削除する。ホスト公開鍵はAWS認証済み経路で取得して固定し、再接続で勝手に交換しない。秘密鍵とhost pinの欠損・不一致も自動再生成しない。

隠しsession-proxyは名前でなく不変UUIDと世代を受け、台帳の終了意図と有効世代を確認する。接続ごとに新しいAWSトークンを発行する。CLIや保存先を移した場合は、同じ鍵を保ったままlauncher configだけを書き直す。AWSでTERMINATEDを確認してからSSHファイルを削除し、履歴とhost pinを残す。

session codeはセッションごとのVS Code user-data-dirを使い、remote.SSH.configFileを渡す。通常のVS Code設定と~/.ssh/configを変更せず、待機用sleepを不要にする。JSONC内のその他の設定を保持する。codeコマンドとRemote-SSH拡張を確認し、起動待ちに上限を設ける。macOSのUnix socket上限を実機で超えたため、専用user-data-dirのUTF-8長が80 bytes超なら起動前に明示エラーとする。

環境変数だけの資格情報はVS Code起動元から継承する。更新後は専用ウィンドウを終了して開き直す。SSOの再ログインは外部で行う。保存先を複数端末で共有する仕組み、Windows SSH、Linuxホスト上のGUIは未検証。

## イメージ4.0と検証

image3.0はcurl/wgetがなく、VS Code Server初回導入がローカル転送用端末の準備で止まった。Remote-SSH0.128とVS Code1.141の端末初期化の循環がコード上の有力候補だが、その因果は確定していない。[公式Linux前提](https://code.visualstudio.com/docs/remote/linux)に従いDockerfileへcurlを追加した。既存検証VMへの追加で接続成功を確認後、cdkd full-waitで開発用イメージ4.0へ反映した。追加・削除0、更新2、再diff0。CloudFormationへの管理移行は行っていない。

型検査と46テスト成功、任意Docker1件skip。実CLIプロセスで同時作成、強制終了後のRun再送防止、明示復旧、作成中stop、別account拒否、失敗時UNKNOWN、credential_process期限を確認した。SSH設定の競合、固定鍵、削除、VS Code設定の保持と期限も検証した。独立レビューで必須指摘は解消済み。

実AWSのイメージ4.0から起動し、追加インストールなしのSSHとVS Code初回接続を確認した。通常の設定ファイルのハッシュ不変、別CLIプロセスからの再接続、停止後のSSH鍵削除を確認し、検証VMは終了済み。実行環境はmacOS ARM64、SSO profile AdministratorAccess-242201303782、ap-northeast-1。最小IAM主体、他のAWS認証方式の実環境、長時間再接続は未検証。

設計比較、修正理由、実機証拠は `.space/tasks/session-management/` に保存した。CLIの通常利用手順はREADMEの名前付きセッション節に記載する。

# Related Concepts
- [Bun CLIを明示IDの5操作から始める](bun-microvm-cli.md): 既存ID指定CLIの認証・出力契約を維持し、永続的な名前指定操作を追加する。

- [AWSのWebSocket経由で接続ごとのOpenSSHを使う](ssh-over-websocket.md): 接続自体は既存のWebSocket経由SSHを再利用し、手元の鍵と設定の寿命をセッション単位へ拡張する。