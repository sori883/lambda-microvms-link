---
type: decision
title: AWSのWebSocket経由で接続ごとのOpenSSHを使う
description: Bun CLIのSSHと標準ファイル転送を、AWS managed shell、接続単位のsshdと一時鍵で提供する設計、信頼境界、寿命、実AWS検証を記録する。
status: stable
governance: context
tags: 
  - MicroVM
  - SSH
  - WebSocket
  - Bun
  - 転送
code_refs: 
  - src/ssh.ts
  - src/managed-shell.ts
  - src/cli.ts
  - src/microvms.ts
  - image/mvm-sshd
  - image/Dockerfile
  - infra/microvm-foundation-stack.ts
  - tests/ssh.test.ts
  - tests/image-ssh.test.ts
  - tests/cli.test.ts
  - tests/foundation.test.ts
  - README.md
  - package.json
sources: 
  - resource: .space/tasks/ssh-over-websocket/task.md
    title: 設計比較・修正・独立レビュー・検証記録
  - resource: .space/tasks/ssh-over-websocket/evidence/aws-smoke.json
    title: イメージ3.0の実AWS SSHと転送検証
  - resource: .space/tasks/ssh-over-websocket/evidence/pty-smoke.json
    title: 実PTYのサイズ変更・Ctrl+C・終了
  - resource: https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md
    title: AWS managed shellの接続仕様
  - resource: https://man.openbsd.org/sshd.8
    title: OpenSSHのinetd動作
  - resource: https://github.com/websockets/ws/blob/master/doc/ws.md
    title: wsのストリームAPI
  - resource: .space/tasks/session-management/task.md
    title: 名前付きセッションとVS Codeの実装・検証
generated: 
  by: agent:codex
  at: 2026-10-20T03:36:42.093Z
---
# AWSのWebSocket経由で接続ごとのOpenSSHを使う

2026年10月20日、ユーザーがWebSocket経由でSSHする方式を承認し、実装とAWS検証を完了した。[Bun CLIの既存契約](bun-microvm-cli.md)と[単一CDK基盤](microvm-foundation.md)を引き継ぐ。ブラウザUI、自動同期、Suspend/Resumeは対象外。

## 選択と責務

独立候補Aの接続ごとのsshd -iを採用した。候補Bの常駐daemon・共有authorized_keys・永続ローカル設定は、追加の共有状態と復旧手順を必要とするため見送った。[共有状態を分ける原則](../principles/separate-before-serializing-shared-state.md)に従い、ホスト鍵だけをVMで共有し、ユーザー公開鍵とsshd設定を接続ごとに作る。比較担当は候補作成に参加していない。

mvm sshは対話端末または明示したリモートプログラムを実行する。引数を個別にPOSIX引用し、シェル構文はsh -lcで指定する。改行とタブを許可し、NULを拒否する。mvm with-sshは子プロセスの寿命だけ一時設定を保持し、MVM_SSH_CONFIGとMVM_SSH_HOST=mvmを渡す。scp/SFTP/rsyncに転送を任せ、ファイルAPIを独自実装しない。ssh-config単独出力は一時設定の寿命が不明になるため採用しない。

src/ssh.tsは一時鍵・設定・子プロセス、src/managed-shell.tsは認証済みWebSocket上のバイナリ転送、src/microvms.tsはAWS APIを所有する。[境界を明確にする原則](../principles/boundary-discipline.md)に従い、SDKのトークンをファイルやログへ渡さない。

## 通信と信頼

手元のOpenSSH→隠しssh-proxyコマンド→wss://endpoint/shell→AWS managed shellのPTY→VM内sshd -i。22番の公開と常駐sshdは不要。subprotocolはlambda-microvms、lambda-microvms.authentication.<token>、lambda-microvms.port.8022。textのsession_initとbinaryのPTYデータを分け、raw/noecho後にnonce付き境界でSSHバイト列へ切り替える。

ws 8.22.0を固定し、Duplexのpause/resumeでbackpressureを扱う。準備出力は64 KiB、単一WSメッセージは16 MiB、ストリームのhighWaterMarkは64 KiB。標準出力の実write完了を待ち、その待機もabort可能にする。通信の生例外と認証トークンは表示しない。

起動はHTTP_INGRESSとSHELL_INGRESSを明示する。旧ALL_INGRESSのVMではAWSがshell tokenを拒否したため、SSHには新CLIから起動したVMが必要。AWS SDK標準credential chainを維持し、lambda:GetMicrovmとlambda:CreateMicrovmShellAuthTokenを使う。token TTLを明示1分とし、接続ごとに取得、メモリ内だけで扱う。

ホスト鍵をビルド時に残すとsnapshot復元先で共有されるため削除する。初回接続時、root所有/run/mvm-sshにflock排他とatomic moveで生成する。IAM認証済み準備接続で公開鍵を受け取り、StrictHostKeyChecking=yesで固定する。これはIAM主体への信頼を起点とし、その主体に対する追加の隔離境界ではない。managed shellを許可された主体はroot操作ができる。

手元では0700の一時ディレクトリに接続用Ed25519鍵とknown_hostsを作り、秘密鍵をVMへ渡さない。VMへ送るのは公開鍵だけ。SSHログインはnode、/workspaceはnode所有。root・パスワード・keyboard-interactive・agent/X11転送を無効にし、SFTPとPTYを有効にする。既存~/.ssh/configを変更せず、agentや接続multiplexingも使わない。

## 寿命と失敗

--timeoutは接続準備の期限で、確立済みのSSHを切る期限ではない。Ctrl+C、SIGTERM、SIGWINCHを子へ適切に渡す。中断時は子プロセスグループを終了し、1秒後も残る場合はSIGKILLする。一時設定は終了時に削除するため、with-ssh内の子はバックグラウンドへ切り離さない。

SSH系は--jsonを拒否し、子のstdout/stderr/exit codeを返す。切断したコマンドの自動再実行、VMの自動終了、作業内容の自動回収はしない。停止前に必要なファイルを明示的に戻す。

sshdをバックグラウンド起動するPOSIX shはstdinを/dev/nullにする。<&0だけではSSH入力が失われるため、起動前にFD3へ保存し、子へ<&3を渡し、余分なFDを親子で閉じる。イメージ2.0の実AWSでexit255を再現し、この修正で3.0を作った。Docker実OpenSSHテストでも旧コードの失敗と修正後の成功を確認した。

## 検証と制約

[動作で確認する原則](../principles/prove-it-works.md)と[利用者の挙動を検証する原則](../principles/test-behavior-not-implementation.md)に従い、モックだけで完了としない。型検査と通常24テスト成功、任意Dockerテスト1件は別途有効化して成功。独立レビューの出力詰まり時abortと複数行引数の指摘を修正し、再確認済み。

SSO profile AdministratorAccess-242201303782、ap-northeast-1でBun経由cdkdのfull-waitデプロイが成功。image3.0、更新2件・追加削除置換0件、再diffは0件。実AWSでhealth、stdout/stderr/exit7、複数行スクリプト、4 MiBのscp/SFTP往復とSHA256一致、rsync往復、同時SSH、誤った鍵の拒否、同VMの鍵維持・別VMの鍵分離、同時初回初期化を確認した。1分tokenと10秒準備期限で75秒後も応答した。実PTYの24x80→35x100、Ctrl+C、その後の操作とexit0も成功した。

コンパイル済み実行ファイルだけを空白と%を含む別ディレクトリへコピーし、/tmpからAWS SSHできた。検証VMはすべてTERMINATED。秘密を含まない証拠を作業記録へ保存した。

確認環境はmacOS ARM64のCLIとARM64 Debian VM。WindowsはSSH機能の対象外。Linuxホスト、最小IAM主体、長時間再接続は未検証。VS Code Remote-SSHの永続設定は後述のセッション追加で実証した。イメージはNode.js24 Bookworm系で、Dockerタグは可変のため完全な再現性を保証しない。自動監視・双方向競合解決・停止前自動保存は今後の設計対象。

## 名前付きセッションへの拡張

2026年10月20日、session操作には永続SSH設定を追加した。従来のssh/with-sshは一時設定の契約を維持する。セッションではUUIDと世代で鍵を分け、台帳への公開を比較更新で確定する。proxyの起動ごとに終了意図と世代を照合し、AWSで終了を確認してから秘密鍵を削除する。

session codeは専用user-data-dirのremote.SSH.configFileを設定し、通常のSSH・VS Code設定を変えずに/workspaceを開く。curlを含むイメージ4.0から初回のVS Code Server導入・接続に成功し、名前でのSSH再接続、設定ハッシュ不変、終了後の鍵削除を実AWS確認した。専用ディレクトリの長さと環境変数資格情報の継承には制約がある。保存・復旧・VS Codeの詳細は名前付きセッションの判断記録にまとめた。

# Related Concepts
- [名前付きセッションを端末のSQLiteで管理する](named-sessions.md): 永続SSH設定と専用VS Codeウィンドウの寿命、競合、終了後の鍵削除を定義する。
