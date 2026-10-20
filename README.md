# lambda-microvms-link

プロジェクトごとのAWS Lambda MicroVMを、手元のCLIから起動・操作する開発環境です。CLIを操作の入口とし、デスクトップの表示には手元のブラウザを使います。

CDK基盤とBun製CLI `mvm` を実装しています。VM起動、一覧、状態、HTTP接続確認、SSH、終了と、名前付きセッションを扱います。セッション名でSSH・VS Code・ブラウザ上のデスクトップへ再接続でき、標準のscp・SFTP・rsyncでファイルを転送できます。自動同期とSuspend/Resumeは未実装です。

## 開発ツール

- Bun 1.4.2（`mise.toml`と`package.json`で指定）
- cdkd 0.301.11
- aws-cdk-lib 2.273.0、constructs 10.8.1
- プロジェクト用の [cdkdスキル](.agents/skills/cdkd/SKILL.md)

```sh
mise install
mise exec -- bun install --frozen-lockfile --ignore-scripts
mise exec -- bun run verify
mise exec -- bun run synth
```

パッケージ管理、CDKアプリ、cdkd、型検査、テストをBunで実行します。`bunfig.toml` の `run.bun = true` により、Node.jsを指定するcdkdやTypeScriptコンパイラーも、`bun run` 経由ではBunで動きます。テストの探索対象は `tests/` に限定しています。

`verify` は型検査、CLIの実プロセスとローカルAWS代替サーバによる検証、実際のスタックの合成、認証情報を外した状態でのcdkdによる読み取り、IAMと作成順序、資材の変更検出、応答プログラムのBun上での起動を検証します。実AWSの認証情報とDockerは不要です。VM内のNode.jsコンテナを確認する手順は下記にあります。

cdkd 0.301.11の公開パッケージはNode.js 22.12以上を動作要件としています。このプロジェクトでは固定した版をBunで検証して使います。更新時も型検査・テスト・cdkdの合成とAWS差分を確認します。Bunでの動作をcdkd全機能の公式サポートとは扱いません。

2026年10月20日、Node.jsの起動を禁止した環境で依存関係の確認、型検査、cdkdのローカル互換性確認と実スタックの合成が成功しました。その後、BunでSSH対応イメージを再デプロイし、`diff --fail-on=any-change` で差分0件を確認しました。

`synth` は `cdk.out/` にテンプレートと資材を生成します。アカウントとリージョンは未指定のままで、AWS APIを呼びません。実際のデプロイ時にcdkdが選択された環境へ解決します。

## CLIでVMを使う

上記の依存関係を導入し、利用するAWS環境にMicroVMイメージを用意してください。このリポジトリの基盤では `lambda-microvms-link-dev` を作成します。CLI自身はイメージを作成・更新しません。

認証はAWS SDKの標準の仕組みを使います。`--profile` / `AWS_PROFILE`、アクセスキーと一時セッションの環境変数、共有設定、SSO、`credential_process`、AssumeRole、Web Identity、実行環境のロールをSDKに解決させます。SSO利用時のログインは、事前に `aws sso login --profile <プロファイル名>` で行ってください。資格情報をCLIの設定ファイルへコピーする必要はありません。詳細は[AWS SDKの認証情報](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)を参照してください。

リージョンは `--region`、`AWS_REGION`、AWS共有設定から解決します。プロファイル・アカウント・リージョンの固定値はCLIにありません。各コマンドに `--profile` と `--region` を付けても利用できます。

次はAWS認証とリージョンを設定済みの場合の例です。起動結果の `microvmId` を次の操作に使います。

```sh
mise exec -- bun run cli --help
mise exec -- bun run cli start --image lambda-microvms-link-dev --duration 300 --json
mise exec -- bun run cli list --image lambda-microvms-link-dev --json
```

`microvm-...` を返されたIDに置き換えます。`stop` はVMを完全に終了します。

```sh
VM_ID='microvm-...'
mise exec -- bun run cli status "$VM_ID" --json
mise exec -- bun run cli check "$VM_ID" --json
mise exec -- bun run cli stop "$VM_ID" --json
```

| 操作 | 動作 |
| --- | --- |
| `start --image <名前またはARN>` | RUNNINGまで待つ。`--image-version` で版を固定できる |
| `list` | 選択したアカウント・リージョンの全ページを取得する。終了済みも表示する |
| `status <ID>` | AWSの現在の状態を取得する。TERMINATEDも正常な取得結果 |
| `check <ID>` | 既定では8080番の `/health` へ認証付きHTTPS GETを送り、2xxなら成功 |
| `ssh <ID> [-- <コマンドと引数>]` | 対話SSH、または指定したリモートプログラムを実行する |
| `with-ssh <ID> -- <ローカルコマンドと引数>` | 一時SSH設定を渡して、手元のscp・sftp・rsyncなどを実行する |
| `stop <ID>` | TERMINATEDまで待つ。終了済みへの再実行も成功 |

`start` と `stop` は `--no-wait` で受付後に戻せます。`start` の結果はその時点の状態、`stop --no-wait` は `terminationRequested: true` を返すため、最終状態は `status` で確認してください。これらの操作は明示したIDを使います。名前で管理したい場合は次の `session` を使います。

VMの存続時間は `--duration` で1〜28,800秒、既定3,600秒です。CLIの操作待機は `--timeout` で1〜3,600秒、既定120秒です。**時間切れやCtrl+CはVMの終了を意味しません。** エラーの `recovery.microvmId` があれば `status` / `stop` で確認・終了してください。IDが得られなかった起動は、返された `clientToken` を `--client-token` に渡し、同じアカウント・リージョン・イメージ・版・存続時間で再試行します。AWSの冪等性保証期間を超えた再試行まで保証するものではありません。

管理操作の `--json` では成功結果を標準出力、単一のエラーオブジェクトを標準エラーへ出します。終了コードは成功0、AWS操作・接続・時間切れの失敗1、引数エラー2、中断130です。SDKの診断ログと生の例外本文は出さず、認証情報や接続トークンの混入を防ぎます。`--help` / `--version` は通常のテキストです。SSH系の出力と終了コードは下記の通りです。

`check` の `--port` / `--path` で確認先を変えられます。トークンは指定ポートだけに限定し、有効期間は1分、保存・表示はしません。リダイレクトを追わず、HTTP本文を読み取るアプリケーション診断は行いません。`check` の成功は、指定したHTTP経路への接続成功を示します。

起動時に `HTTP_INGRESS` と `SHELL_INGRESS` を指定します。旧CLIの `ALL_INGRESS` で起動したVMはシェル用トークンを発行できなかったため、SSHには新しいCLIから起動したVMを使ってください。実行ロールとCloudWatch実行ログは付けません。外向き通信はAWSの既定に従い、パブリックインターネットへ接続できます。[AWSのネットワーク仕様](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)を参照してください。

CLIの利用者には `lambda:GetMicrovmImage`、`lambda:RunMicrovm`、`lambda:ListMicrovms`、`lambda:GetMicrovm`、`lambda:CreateMicrovmAuthToken`、`lambda:TerminateMicrovm` が必要です。対象イメージを制限するIAMポリシーは[AWSの権限リファレンス](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html)を参照してください。CDK基盤を作る権限とは別です。

イメージ名を指定した場合は、一覧から対応するARNを探すため `lambda:ListMicrovmImages` も必要です。ARNを直接指定した場合、この一覧取得は行いません。

2026年10月20日、Bunのコンパイル済みCLIを作業フォルダの外から実行し、東京リージョンで5操作が成功しました。接続確認はHTTP 200、検証VMはTERMINATEDまで確認済みです。[実AWSの検証結果](.space/tasks/bun-cli/evidence/aws-smoke.json)を参照してください。環境変数・一時セッション・共有プロファイル・`credential_process` はローカルで署名付き要求を確認し、SSOはこの実AWS検証で確認しました。AssumeRole・Web Identity・ECS/EC2ロールの実環境、およびmacOS ARM64以外の配布環境は未検証です。

### 名前付きセッション

1セッションを1台のVMに対応付けて、手元のプロジェクトと名前を記録します。同じプロジェクトに複数のセッションを作れます。`--project` は関連付けだけで、ファイルのアップロードやマウントは行いません。

```sh
./dist/mvm --profile <プロファイル名> --region ap-northeast-1 \
  session create demo --project ./work/test \
  --image lambda-microvms-link-dev --duration 3600

./dist/mvm session list
./dist/mvm session status demo
./dist/mvm session ssh demo
./dist/mvm session code demo
./dist/mvm session stop demo
```

`create` でイメージの版、アカウント、リージョン、プロファイル参照を固定します。以降の操作では保存した対象を使い、現在の資格情報のアカウントをSTSで照合します。SSO以外もAWS SDKの標準認証を使えます。AWS資格情報やWebSocketトークンは保存しません。

| 操作 | 動作 |
| --- | --- |
| `session create <名前> --image <イメージ>` | VMを起動しRUNNINGまで待つ。`--project` の既定は現在のディレクトリ |
| `session list` | 手元に登録したセッションをAWSと照合して一覧表示 |
| `session status <名前>` | 現在の状態と存続期限を確認 |
| `session ssh <名前> [-- <コマンド>]` | 同じVMへSSH接続 |
| `session with-ssh <名前> -- <ローカルコマンド>` | 永続SSH設定とホスト名を環境変数で渡す |
| `session code <名前>` | 専用VS Codeウィンドウで `/workspace` を開く |
| `session desktop <名前>` | 手元のブラウザにVMのデスクトップを表示 |
| `session stop <名前>` | 終了を確認し、SSH鍵と接続設定を削除。履歴は残す |
| `session recover <名前> --id <VM ID>` | 起動結果不明時に、明示したVMとの整合性を確認して関連付ける |

名前は端末の利用者ごとに一意です。終了済みの名前も履歴として残すため、新しいVMには別の名前を付けます。CLIやVS Codeを閉じてもVMは終了せず、設定を保持するための待機コマンドも不要です。VMの存続期限を過ぎた場合は再作成せず、終了状態を表示します。終了時に必要なファイルを手元へ戻す操作は引き続き必要です。

接続設定・SSH秘密鍵・台帳は `~/.mvm` に保存します。`MVM_HOME` で保存先を変更できます。保存先はこの端末の利用者専用にし、Gitや他端末と共有しないでください。一覧はAWSの照合に失敗した行をUNKNOWNとして扱い、前回のRUNNINGを現在の状態として表示しません。台帳を消してもAWS上のVMは終了しません。

起動の応答を受け取れなかった場合、同名の `create` を繰り返してもRunを自動再送しません。`session list` と従来の `list` で対象を確認し、IDが分かれば `session recover` を使います。復旧対象のアカウント・リージョン・イメージ・版・時刻・寿命を確認しますが、同じ条件で作ったVMを自動判別する機能ではありません。

VS Codeでは手元の `code` コマンドとRemote-SSH拡張が必要です。`session code` はセッションごとの専用user-data-dirへSSH設定を渡すため、通常のVS Code設定や `~/.ssh/config` を変更しません。通常ウィンドウのテーマやUser設定は引き継ぎません。SSH設定と鍵はCLIが終了した後も残ります。環境変数だけの資格情報を使う場合、その環境から起動してください。資格情報を更新した場合は専用ウィンドウを終了して開き直します。保存したプロファイルがSSOを使う場合は、必要に応じて外部で再ログインしてください。

VS Codeはローカルソケット名に長さの制限があるため、専用user-data-dirがUTF-8で80バイトを超える保存先では起動前にエラーにします。既定の `~/.mvm` を使うか、既存の台帳ごと短い保存先へ移して `MVM_HOME` を指定してください。VM側にはVS Codeの導入に必要なcurlを含む新しいイメージを使います。

名前付きセッションでもrsyncを利用できます。ホスト名はセッションごとに異なるため、`MVM_SSH_HOST` を使います。

```sh
./dist/mvm session with-ssh demo -- sh -c \
  'rsync -av -e "ssh -F \"$MVM_SSH_CONFIG\"" ./work/test/ "$MVM_SSH_HOST":/workspace/'

./dist/mvm session with-ssh demo -- sh -c \
  'scp -F "$MVM_SSH_CONFIG" "$MVM_SSH_HOST":/workspace/result.txt ./result.txt'
```

2026年10月20日、型検査と46テストが成功しました（任意Dockerテスト1件はスキップ）。東京リージョンのイメージ4.0から起動し、名前でのSSH再接続、VS Codeの初回導入と `/workspace` 接続、終了後のSSH鍵削除まで確認しました。通常のSSH・VS Code設定は変更されず、検証VMは終了済みです。[名前付きセッションの実AWS検証](.space/tasks/session-management/evidence/aws-smoke.json)と[新イメージの初回接続](.space/tasks/session-management/evidence/fresh-smoke.json)を参照してください。

### デスクトップとVM内のブラウザ

デスクトップ対応のイメージから作ったセッションを指定します。手元にはOpenSSHとブラウザが必要です。開発用イメージ `lambda-microvms-link-dev` は初回起動の待機処理を修正した7.0を使ってください。`session create` で版を省略すると最新の有効版を固定します。

```sh
./dist/mvm session desktop demo
```

初回はGUIとChromiumの起動を待ちます。7.0の実AWSの新しいVM2台では約36〜39秒でした。VM内の準備全体には90秒の期限を設けています。準備中にターミナルを閉じずに待ってください。

手元のブラウザが開き、VM内のXfceデスクトップとChromiumを操作できます。VMで開発サーバーを3000番に起動していれば、画面内のChromiumで `http://localhost:3000` を開きます。この `localhost` はVM自身を指します。プロジェクトの転送や開発サーバーの起動は、SSHやVS Codeで別途行ってください。

接続中はターミナルを開いたままにします。Ctrl+Cで画面への接続を終えてもVMとデスクトップは残り、同じコマンドで戻れます。VMの存続期限や `session stop` でVMが終了すると、画面とブラウザの状態も失われます。

ブラウザを自動で開かない場合は `--no-open` を付け、表示されたURLを開きます。そのURLには、このCLIが動いている間の接続用秘密を含むため共有しないでください。ポートは空いているものを自動選択します。固定したい場合だけ `--port 6080` のように指定できます。初版のVM画面は1280×800で、手元の表示領域に合わせて縮尺を変えます。

```sh
./dist/mvm session desktop demo --no-open --port 6080
```

画面はnoVNCを使い、手元の127.0.0.1でだけ配信します。接続先と接続用秘密を検証してから既存のSSH経路へつなぐ構成で、AWS側にVNC用の公開ポートを追加しません。VM内も利用者専用のUnix socketを使い、Chromiumのsandboxは有効にします。ブラウザへAWS資格情報やSSH秘密鍵は渡しません。

自動起動では接続用URLをOSのブラウザ起動へ渡します。プロセス引数やブラウザの状態を読めるローカル利用者から、URLの秘密を隠す保証はありません。手元の利用者環境を信頼できる端末で使ってください。

以前のイメージにはGUIがないため、新しいイメージから別名のセッションを作成してください。既存セッションのイメージを途中で差し替える機能はありません。デスクトップ接続は `--json` に対応しません。`--timeout` は画面の準備までの期限です。

`DesktopStartupFailed` には、VMが返した既知の失敗段階も表示します。詳しい結果は `./dist/mvm session ssh demo -- cat /tmp/mvm-desktop-1000/failure.json` で確認できます。6.0ではXvncの準備を15秒、確認コマンドを2秒で打ち切る不具合がありました。7.0では各処理が起動全体の期限を共有し、プロセスが終了した場合は待機を中断します。

2026年10月20日、macOSの単体CLIとAWSのイメージ6.0で、初回接続、VM内の `localhost:3000` 表示、マウス・キーボード入力、Chromiumのsandbox、healthを確認しました。イメージ5.0では画面の再接続、CLI終了後の状態保持、Ctrl+Cと強制終了での子プロセス回収も確認しています。[実装・検証記録](.space/tasks/desktop/task.md)と[実際の画面](.space/tasks/desktop/evidence/desktop-final.png)を参照してください。

その後のユーザー実行で6.0の初回Xvnc失敗が判明し、修正した7.0の新しいVM2台で再試行なしの起動と、そのうち1台で実画面を確認しました。通常テスト56件とGUI Dockerテスト5件が成功しています。[修正版の初回起動](.space/tasks/desktop/evidence/startup-fix/fresh-starts.json)と[画面](.space/tasks/desktop/evidence/startup-fix/image7-desktop.png)を参照してください。

### VM IDを指定するSSHとプロジェクトの転送

macOSまたはLinuxで、手元に `ssh` と `ssh-keygen` が必要です。転送には利用する `scp`、`sftp`、`rsync` も用意してください。AWS側では `lambda:GetMicrovm` と `lambda:CreateMicrovmShellAuthToken`、シェル用コネクターの利用が許可されている必要があります。VMイメージは、このリポジトリのSSH対応版を使います。

```sh
./dist/mvm ssh "$VM_ID"
./dist/mvm ssh "$VM_ID" -- uname -a
./dist/mvm ssh "$VM_ID" -- sh -lc 'cd /workspace && ls -la'
```

ログインユーザーは `node`、ホームは `/home/node`、作業用ディレクトリは `/workspace` です。引数は個別に引用して渡します。パイプ、リダイレクト、複数行スクリプトなどのシェル構文には `sh -lc` を明示します。CLIのオプションは `--` より前へ置きます。SSH系は `--json` を受け付けず、子コマンドの標準出力・標準エラー・終了コードを返します。

`with-ssh` は、子プロセスの実行中だけ有効なOpenSSH設定を `MVM_SSH_CONFIG`、接続先の別名 `mvm` を `MVM_SSH_HOST` に渡します。次の例は `./work/test/` の内容を `/workspace/` に転送します。rsyncは同名ファイルを更新します。例に削除オプションはなく、リモートだけにあるファイルは残ります。

```sh
./dist/mvm with-ssh "$VM_ID" -- sh -c \
  'rsync -av -e "ssh -F \"$MVM_SSH_CONFIG\"" ./work/test/ mvm:/workspace/'

./dist/mvm with-ssh "$VM_ID" -- sh -c \
  'scp -F "$MVM_SSH_CONFIG" mvm:/workspace/result.txt ./result.txt'

./dist/mvm with-ssh "$VM_ID" -- sh -c \
  'sftp -F "$MVM_SSH_CONFIG" mvm'
```

これは明示的に実行する転送です。変更の監視、双方向の競合解決、停止前の自動保存は行いません。VMを終了すると作業ファイルも失われるため、必要な変更を手元へ戻してから `stop` してください。

接続は手元のOpenSSH → CLIのProxyCommand → AWSの認証付きWebSocket → VM内の `sshd -i` と進みます。22番の外部公開や常駐SSHサーバーは不要です。AWSトークンは接続ごとに1分で発行し、メモリだけで扱います。

ホスト鍵はVM内で初回接続時に生成し、AWS認証済みの経路で取得した公開鍵へ固定します。手元のクライアント秘密鍵をVMへ送らず、接続ごとの公開鍵だけを渡します。パスワード・rootログイン・SSH agent転送は無効です。managed shellに入れるIAM主体はVM内でroot操作ができるため、SSH鍵をその主体に対する追加の隔離境界とは扱いません。

手元の鍵と設定は呼び出しごとの一時ディレクトリに作り、子プロセスの終了・中断時に削除します。既存の `~/.ssh/config` は変更しません。`with-ssh` 内のコマンドはバックグラウンドへ切り離さず、転送が終わるまで待つ形にしてください。

SSH系の `--timeout` は接続準備の期限です。確立したセッションを120秒で終了する設定ではありません。接続断でコマンドを自動再実行せず、VMの終了も行いません。永続設定とVS Code連携には前述の `session` を使います。Windows対応は未検証です。

2026年10月20日、東京リージョンのイメージ3.0で、コマンドの出力・終了コード、対話操作、端末サイズ変更、Ctrl+C、scpの4 MiB往復とハッシュ一致、rsync往復、同時接続を確認しました。誤ったホスト鍵・クライアント鍵は拒否され、ホスト鍵は同一VM内で維持され、別VMでは異なりました。1分の接続トークンと10秒の準備期限で、75秒後もコマンドを実行できました。検証VMはすべて終了済みです。[AWS検証結果](.space/tasks/ssh-over-websocket/evidence/aws-smoke.json)と[対話操作の結果](.space/tasks/ssh-over-websocket/evidence/pty-smoke.json)を参照してください。

### 単体の実行ファイルを作る

```sh
mise exec -- bun run build
./dist/mvm --help
```

実行したOS・CPU向けの `dist/mvm` ができます。Bunを同梱するため、作成後はBunやこのリポジトリを置いていない場所からも実行できます。AWSの認証・リージョン設定は引き続き必要です。パッケージ公開・各OS向け配布はまだ行っていません。

デスクトップの画面資材も実行ファイルに同梱します。noVNCは1.7.0へ固定し、`build:desktop` で生成、`verify:desktop-assets` で生成元との一致を確認します。開発用の画面を変更した場合も再生成してください。ライセンス通知はデスクトップ画面の「Licenses」から参照できます。

通常の検証は `mise exec -- bun run verify` です。GUIのDockerテストは明示的に有効にします。テストはChromiumのnamespace sandboxを動かすため、検証用コンテナに限って `seccomp=unconfined` を指定します。製品のAWS設定は変更しません。

```sh
docker build --platform linux/arm64 -t lambda-microvms-link:desktop-unit image
MVM_DESKTOP_TEST_IMAGE=lambda-microvms-link:desktop-unit mise exec -- bun run test tests/image-desktop.test.ts
```

実装は [src/cli.ts](src/cli.ts)（引数・出力・期限）、[src/microvms.ts](src/microvms.ts)（AWS操作）、[src/ssh.ts](src/ssh.ts)（OpenSSH連携）、[src/managed-shell.ts](src/managed-shell.ts)（WebSocket転送）に分けています。名前付き管理は [src/sessions.ts](src/sessions.ts)（操作と復旧）、[src/session-store.ts](src/session-store.ts)（SQLite）、[src/session-aws.ts](src/session-aws.ts)（認証先の照合）、[src/session-ssh.ts](src/session-ssh.ts)（永続SSHとVS Code）です。[セッション管理の作業記録](.space/tasks/session-management/task.md)に設計比較・レビュー・検証結果を記録します。

画面接続は [src/desktop.ts](src/desktop.ts)、ブラウザ側は [src/desktop-client](src/desktop-client)、VM側のGUI管理は [image/desktop.mjs](image/desktop.mjs) が担当します。

## 作成するもの

スタック名は `MicrovmFoundation`、イメージ名は `lambda-microvms-link-dev` です。同じアカウント・リージョンに一つの開発用イメージを置く構成です。

| ファイル | 役割 |
| --- | --- |
| [infra/microvm-foundation-stack.ts](infra/microvm-foundation-stack.ts) | 資材、権限、ログ、ARM64・2 GiBのMicroVMイメージを定義 |
| [image/Dockerfile](image/Dockerfile) | health、OpenSSH、転送ツール、Xfce、Chromiumと作業ディレクトリを格納 |
| [image/server.mjs](image/server.mjs) | `/health` とAWSのready・validateフックに応答 |
| [image/mvm-sshd](image/mvm-sshd) | VM固有のホスト鍵と接続ごとのSSHサーバーを準備 |
| [image/desktop.mjs](image/desktop.mjs) | デスクトップの起動・再利用とVNCの接続を管理 |
| [tests/](tests/) | 合成物、資材の更新、実プロセスへのHTTP要求を検証 |

CDK AssetはDockerfile、server.mjs、mvm-sshd、mvm-desktop、desktop.mjsをZIPにまとめます。cdkdが初回のbootstrapで用意する資材用S3へアップロードするため、独自のアップロード処理や専用バケットは追加していません。ファイル内容が変わると資材のキーが変わり、同じイメージの新しいバージョンをビルドする入力になります。

ビルドロールはLambdaサービスだけが引き受けられます。許可する操作は、そのZIP一つの読み取りと、専用ロググループ内への書き込みです。ロググループはCDKで先に作成し、ビルドロールとロググループができてからイメージを作ります。VM実行用のAWS権限はまだ追加していません。

ログは7日で期限切れになります。スタックを削除した場合もロググループは保持する設定です。同名で作り直す際は、保持されたロググループの扱いを決める必要があります。

## イメージをローカルで確認する

Dockerが動いていれば、AWSにデプロイせずARM64コンテナを確認できます。

```sh
docker build --platform linux/arm64 -t lambda-microvms-link:foundation image
docker run --rm --platform linux/arm64 -p 127.0.0.1:8080:8080 lambda-microvms-link:foundation
```

別のターミナルから `curl http://127.0.0.1:8080/health` を実行すると `{"status":"ok"}` を返します。終了はコンテナを実行したターミナルでCtrl+Cです。

現在はNode.js 24 Debian Bookworm系のコンテナです。SSHホスト鍵はビルド時に除去し、復元後の初回接続時に生成します。コンテナの起動確認だけでは、AWS上のスナップショット取得・復元は検証できません。[スナップショットの仕様](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-container-base-images)も参照してください。

SSHサーバーをローカルで検証する場合は、次を追加で実行します。実OpenSSHによる接続、終了コード、同時接続、ホスト鍵の維持、接続後の後片付けを確認します。この検証用コンテナは終了時に削除します。

```sh
docker build --platform linux/arm64 -t lambda-microvms-link:ssh image
MVM_SSH_TEST_IMAGE=lambda-microvms-link:ssh mise exec -- bun run test tests/image-ssh.test.ts
```

## AWSでの確認結果と再デプロイ

プロファイル `AdministratorAccess-242201303782`、アカウント `242201303782`、リージョン `ap-northeast-1` で確認しました。cdkdのbootstrapと3リソースのデプロイ後、デスクトップ対応のバージョン `7.0` まで更新しました。イメージの `LatestActiveImageVersion` は `7.0` です。更新でのリソース追加・削除・置換はなく、最終diffも変更なしです。[現在の状態](.space/tasks/desktop/evidence/startup-fix/cdkd-state.json)と[最終デプロイ](.space/tasks/desktop/evidence/startup-fix/cdkd-deploy.log)を参照してください。

初版1.0では一時VMを起動し、認証なしの `/health` が403、8080番ポートだけを許可したトークン付きの要求が200と `{"status":"ok"}` を返すことを確認しました。3.0でもCLIのHTTP接続確認が成功しています。VMは検証後に終了済みです。トークンは保存していません。[初版の実機検証](.space/tasks/microvm-foundation/evidence/aws-smoke.json)を参照してください。

次の開発用に残しているリソースは以下です。

| リソース | 名前 |
| --- | --- |
| MicroVMイメージ | `lambda-microvms-link-dev`（最新の有効版7.0） |
| ビルド用ロール | `MicrovmFoundation-BuildRole` |
| ロググループ | `/aws/lambda-microvms/lambda-microvms-link-dev` |
| cdkd状態保存バケット | `cdkd-state-242201303782` |
| cdkd資材バケット | `cdkd-assets-242201303782-ap-northeast-1` |
| cdkdコンテナ資材リポジトリ | `cdkd-container-assets-242201303782-ap-northeast-1`（bootstrapが作成、今回未使用） |

変更後は同じ環境で差分とdry-runを確認し、デプロイします。bootstrapは準備済みです。

```sh
export AWS_PROFILE=AdministratorAccess-242201303782
export AWS_REGION=ap-northeast-1
aws sts get-caller-identity
mise exec -- bun run cdkd diff MicrovmFoundation --fail-on=destructive
mise exec -- bun run cdkd deploy MicrovmFoundation --dry-run
mise exec -- bun run cdkd deploy MicrovmFoundation --full-wait
```

cdkdはAWS APIを直接呼ぶため、実行者にはIAM・ログ・イメージ・資材の操作権限と、ビルドロールをLambdaへ渡す `iam:PassRole` が必要です。

イメージ定義はcdkd向けです。CDK 2.273.0のMicroVM型とCloudFormation検証は、APIで省略できる基底イメージのバージョン等も必須にしています。このため `CfnResource` でAPIに必要な設定を渡し、このリソースの必須項目警告 `F3003` だけを理由付きで承認しています。CloudFormation経由の `cdk deploy` は検証対象にしていません。

基底MicroVMイメージは通常、ビルド時の最新バージョンを使います。利用可能な版を確認した後、cdkdのcontext `-c baseImageVersion=<実際のバージョン>` で固定できます。コンテナのFROMも更新されるタグのため、現時点ではビルド内容の完全な再現性は保証しません。

資材アップロード後のURIとIAM権限の一致、フックを有効にしたAWS上のイメージビルド、復元後の認証付き応答を確認済みです。更新時にも非同期ビルドの完了を待ちます。失敗・中断した場合はcdkdのevents・stateとビルドログを確認してから再試行し、ロックやリソースを自動削除して進めません。

[cdkdの公開元](https://github.com/go-to-k/cdkd)は開発・テスト用途を対象としています。導入元、検証結果、未確認事項は[適合確認の記録](.space/tasks/cdkd-feasibility/task.md)を参照してください。

以前の `verify:cdkd` は仮の資材を使うツール適合確認用として残しています。現在の実装の確認には `verify` を使います。今回の設計・検証結果は[CDK基盤の作業記録](.space/tasks/microvm-foundation/task.md)を参照してください。
