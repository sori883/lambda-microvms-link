# SSH over WebSocket

2026-10-20。ユーザーがAWSのWebSocket経由でSSHする方式を承認。実装と検証まで進める。ブラウザUIは対象外。

## 完了条件と工程

- Bun CLIからSSHコマンド実行・対話接続ができる。
- 標準OpenSSHとの連携とバイナリ転送を確認する。自動同期・削除の仕様は別単位。
- AWS資格情報は既存の標準SDK chain、トークンは非保存・非表示。
- SSH接続の信頼、並行接続、接続期限と終了の扱いを設計し、独立レビューする。
- 既存5操作とHTTP healthを保つ。検証で作ったVMは終了を確認する。

中規模の機能追加。調査・設計・実装・検証・独立レビュー・引き渡しを実施し、計画は本記録へ統合。構造の異なる候補A/Bを独立担当が作成し、比較担当が判定した。親が実装・AWS操作・共通文書を所有する。全ファイルに既存の未コミット変更があるため、それらを保持する。

## 調査

- profile AdministratorAccess-242201303782、STS account242201303782、region ap-northeast-1を確認。
- 現行image1.0のALL_INGRESSではCreateMicrovmShellAuthTokenがValidationException: SHELL_INGRESS required。検証VM82ce3306は終了済み。
- HTTP_INGRESS+SHELL_INGRESSで起動し、Bun WebSocketからwss://endpoint/shellと認証・port8022のsubprotocolsで接続成功。
- text frameはsession_init。binary frameはPTY入出力。uid0/root、Alpine3.24.2、/app/server.mjsが見え、アプリと同じ環境。sshd未インストール。検証VMf14708c0は終了済み。
- 調査用スクリプト: probe.mjs。トークンの保存なし。
- microvm-funはLICENSE不明のためコードを取り込まず、公式仕様とOpenSSHを使って独自実装する。

## 適用原則

全rule検索0件、principle23件のdescriptionを確認。境界で入力検証しトークンを出力へ渡さない、並行接続の共有状態を減らす、異なる構造を比較する、型で状態を扱う、実CLIとAWS経路の結果で検証する原則を適用。src/**はdecisions/bun-microvm-cli、image/infra/testsはdecisions/microvm-foundationのcode_refsと本文を確認。既存の操作・認証・出力・冪等性契約を引き継ぐ。

## 状態

実装・独立レビュー・実AWS検証を完了。検証VMは全てTERMINATED。自動同期・Suspend/Resume・Windows・VS Code Remote-SSHの常設設定は今回の対象外。

## 設計・計画

独立候補A/Bと、候補作成に参加していない比較担当の判定を確認。Aの接続ごとsshd-iを採用。Bの常駐daemon・共有authorized_keys・永続ローカル設定は管理対象を増やすため見送り、標準OpenSSH/SFTP/rsyncへ委ねる境界は取り込んだ。

公開面はmvm sshとmvm with-ssh。with-sshは子プロセスへMVM_SSH_CONFIGとhost alias mvmを渡し、子の終了まで一時設定・鍵を保持する。ssh-config単独出力は一時物の寿命が定まらないため採らない。ProxyCommandは隠しssh-proxyを起動し、接続ごとにAWS tokenを取得する。host鍵だけVM内で共有し、初回接続でflock排他生成する。IAM認証済み準備接続でhost公開鍵を取得し、StrictHostKeyChecking=yesで固定する。

U1: VMhelperとCDK資材（cli_design_b所有の4ファイル）、U2: CLI/transportと統合（親）、U3: WS/設定の局所検証（cli_design_a所有tests/ssh.test.ts）、U4: 親の実CLI/AWS検証と独立レビュー、U5: README/OKF記録。U1/U2はmarkerプロトコルを共有し並行可能、実証は両方完成後。共有書込を避け、AWS変更は親だけが行う。

VMはDebian/glibcへ変更し一般ユーザーnodeでSSHログイン、workspaceはnode所有。snapshot前のhost鍵を除去。binary転送のpause/resumeを扱えるwsを固定依存として採用。

## 現時点の確認

- ARM64 Docker build成功、container root経由helper host-key応答成功。
- 型検査と既存15テスト成功。グローバルoptionの位置互換を一度壊したが、既存テストで検出し、positional parsingを元に戻して修正した。ssh/with-sshの外部引数は -- で区切る。
- cdkd diff: create0/update2/delete0、置換なし。IAM更新は新しい資材ZIP一個への参照変更、Imageは内容更新。既存版を削除しない。

## 実機で判明した修正と独立レビュー

image2.0の実CLIでSSHがbanner後に終了コード255となった。検証VM62618eeaは終了済み。診断VM15339af5でsshdログのkex_exchange_identificationを確認。POSIX shのバックグラウンド起動がstdinを/dev/nullにするため、<&0だけでは入力を引き継げないことが原因。FD3へ保存し子へ渡して両方の余分なFDを閉じる修正で、同じAWS VMでstdout hellonode、stderr err、exit7が成功。診断VMは終了済み。

Docker実SSHテストを追加し、旧helperはexit255で失敗、新helperはexit7/stdout/stderr、同時接続、鍵維持、session cleanupが成功。通常のverifyはDockerなしで24pass/1skip。明示MVM_SSH_TEST_IMAGE実行はDockerテストを有効にする。

診断VMの対話SSHではpwd=/home/node、stty size=24 80、sleep60をCtrl+Cで停止して同じセッションを続け、exit0で終了した。後述の正式版3.0でも対話と転送を確認した。

独立レビューcli_compareは、stdoutが詰まった際のabort待機と、リモート複数行スクリプトを設定パス用validationで拒否する点を指摘。stdout待機をabortableにし、リモート引数はNULだけ拒否する引用へ分離。担当が同じ局所再現を再実行し、abortが返りcleanupへ進むことを確認、両指摘解消。他の認証・host pin・資材許可リストに修正必須指摘なし。

## 最終検証と引き渡し

- `mise exec -- bun run verify`: 型検査成功、24 pass / 1 skip / 0 fail。skipは明示したDockerイメージを使う任意テスト。これを別途有効にした実OpenSSH検証も成功。
- `mise exec -- bun run build`: 単体実行ファイル生成成功。空白と%を含む一時パスへ実行ファイルだけをコピーし、作業ディレクトリを/tmpにしてAWS SSHのstandalone-ok応答を確認。一時コピーは削除した。
- cdkdでimage3.0をfull-wait更新し、124.29秒で完了。update2/create0/delete0、置換なし。再diffは差分0件。状態のロックなし、LatestActiveImageVersion=3.0、最新runはSUCCEEDED。証拠はevidence/cdkd-state.jsonとcdkd-runs.json。
- 正式版3.0でHTTP health、stdout/stderr/exit7、複数行リモートスクリプト、4,194,304 bytesのscp/SFTP往復とSHA256一致、rsync往復、同時SSH、誤ったホスト鍵・クライアント鍵の拒否を確認。
- ホスト鍵は同じVMで維持、別VMでは相違。2番目のVMの初回準備を同時に行い、鍵の競合がないことを確認。
- --timeout10秒とtoken TTL1分で接続を作り、75秒後にも応答。これは確立済み接続の検証であり、無期限の維持を保証しない。
- 実PTYで端末サイズ24x80→35x100、Ctrl+Cによるsleep停止、その後の操作とexit0を確認。evidence/pty-smoke.jsonに記録。
- 最終検証VM6bc70953と796964fbはfinallyでTERMINATED。初期調査・失敗・診断の4台も終了済み。実行ファイルSHAと各確認項目はevidence/aws-smoke.jsonに保存。修正前の失敗証拠もaws-smoke-before-stdin-fix.jsonへ保持。
- READMEにSSH/with-ssh、rsync/scp/SFTP例、認証と一時ファイルの寿命、旧ALL_INGRESS VMの作り直し、現行3.0の状態を記載。

今回の転送は明示的なrsync等による操作。自動監視・競合処理・停止前の回収は未実装。Linuxを含む配布環境の実機確認、最小権限IAM主体、VS Code、Windowsは未検証。macOS ARM64のCLIとARM64 Debian VMで動作を実証した。

OKFにdecisions/ssh-over-websocketを作成し、既存CLI・基盤の判断記録から関連付けた。3文書をCLIで読み戻して入力本文との一致を確認。strict/drift検証はerrors/warnings/broken links/staleが0、is_conformant=true。共通原則の既存孤立文書が17件残るためgate_passed=false（開始時20件）。今回の判断文書に孤立はなく、無関係なリンクの追加で解消したことにはしない。検証結果はevidence/okf-validation.json。git diff --checkも成功した。

## 利用の一巡を再実演

2026年10月20日10:48〜10:49 JST、ユーザーの「一連の流れをもう一度見てみたい」に応じて既存CLIを使った小規模な実演を行った。設計と実装は既存成果物を再利用し、追加開発は行わない。STSで承認済みアカウントを確認後、image3.0から最大600秒のVM microvm-e6d59f20-ddc6-33b7-88fb-7ee193521664を起動した。

SSHでnode/Linux/workspaceを確認し、手元のmain.mjsとmessage.txtをrsyncで/workspaceへ転送。VM上のNode.jsで文章を大文字へ変換してresult.jsonを作り、scpで手元へ戻した。戻したJSONはVMの出力と完全一致。finallyでVMを終了し、TERMINATEDを確認した。

実演の実行補助はdemo.mjs、入力と出力はwork/ssh-demo-wtOwJT/project/とdownload/result.json、各CLI引数と結果はwork/ssh-demo-wtOwJT/run.jsonに残した。新たな設計判断はないためOKF文書の重複作成は行わない。
