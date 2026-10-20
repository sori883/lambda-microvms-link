# 候補A：接続ごとのsshdとOpenSSHラッパー

2026-10-20、担当 `/root/cli_design_a`。設計候補・未実装。他候補は読んでいない。所有ファイルは本書のみ。

## 確認済みの前提

既存Bun CLIのID明示・SDK標準認証を引き継ぐ。親の実機probeでは、managed shellはrootで既存Alpine/appと同じファイルを参照でき、公式 `/shell` とsubprotocols、Bun native WebSocketで `session_init` textとPTYのbinary frameを確認した。sshdは未導入。ALL_INGRESSではshell用トークンを発行できず、起動時のHTTP_INGRESS＋SHELL_INGRESSが必要。probe VMは終了済み。

公開鍵認証、sshdのinetd動作、SFTP、PTYのbinary透過、長時間接続、速度と終了通知は未確認。参考sampleにはLICENSEがないためコードをコピーしない。公式 `/shell` を利用し、sampleのroot endpoint方式への自動fallbackは持たない。

## 利用例

以下は提案する公開面。SSH・転送の実処理はローカルのOpenSSH/rsyncへ任せる。

```sh
mvm ssh <id>
mvm ssh <id> -- uname -a
mvm scp <id> -- ./result.txt :/workspace/result.txt
mvm scp <id> -- :/workspace/result.txt ./result.txt
mvm sftp <id>
mvm rsync <id> -- -av ./project/ :/workspace/project/
```

`:`は対象VM側のパスを示す。既存の `--profile` / `--region` は任意。通常のSSHセッションのstdout/stderrと終了コードを保持し、データストリームにはJSONや進捗を混ぜない。転送コマンドのremote-to-remote指定は初版に含めない。SSH接続でVM起動・停止を暗黙実行しない。

## 接続の手順とデータ所有

1. CLIがRUNNINGと必要なローカルツールを確認する。呼出し専用の0700一時ディレクトリにSSHクライアント鍵、known_hosts、proxy用の非秘密contextを用意する。秘密鍵はローカルだけに0600で保存し、SSH agentの暗黙利用・forwardingは行わない。
2. 短命で8022番だけを許可したAWSトークンをメモリ上で作り、managed WSSの準備接続を開く。VM側helperがホスト鍵を未作成なら生成し、その公開鍵を返す。CLIはIAM認証済み経路で取得した公開鍵を今回専用のknown_hostsへ書く。ホスト鍵生成はimageビルド/スナップショットの後に行い、複製VM間で秘密鍵を共有しない。
3. CLIが実際の `ssh` / `scp` / `sftp` / `rsync` をspawnする。SSH設定は `StrictHostKeyChecking=yes`、専用known_hosts、VM ID由来HostKeyAlias、専用IdentityFile、`IdentitiesOnly=yes` とし、接続多重化・agent forwardingは初期版で無効化する。ユーザーの無関係なSSH configを読み込ませない。準備接続はここまでに閉じる。
4. OpenSSHのProxyCommandとして起動された内部 `mvm ssh-proxy` が、接続ごとに新しいAWSトークンとWSSを取得する。shellをraw/noechoへ切り替え、同梱helperへ公開鍵を渡す。helperは接続固有のauthorized_keysとsshd設定を作り、`sshd -i` を起動する。各SSH接続が専用sshd・PTY・WSSを持つ。
5. 接続helperはsshdを待ち、終了時にその接続だけのauthorized_keysと設定を削除する。ローカル親は子終了後に鍵・known_hosts・contextを削除する。途中切断は成功と扱わず、コマンドや転送を勝手に再実行しない。

VM状態の台帳は追加しない。一時ファイルは今回のSSH呼出しにだけ属し、他プロセスと共有しない。VM側の共有状態はホスト鍵一組だけに限定し、初回作成を排他＋一時ファイルからrenameで確定する。生成済みの鍵は再接続時にも保ち、通常接続では変更しない。クライアント公開鍵は接続ごとの別ファイルにするためauthorized_keys追記の共有競合がない。

## 骨組み

```ts
type SshTarget = { vmId: string; profile?: string; region?: string };
type SshSession = { target: SshTarget; workDir: string; identityPath: string; knownHostsPath: string; contextPath: string };
async function prepareSsh(target: SshTarget): Promise<SshSession>;
async function runOpenSsh(session: SshSession, tool: 'ssh' | 'scp' | 'sftp' | 'rsync', args: string[]): Promise<number>;
async function proxyStdio(contextPath: string, io: BinaryIO): Promise<void>;
async function disposeSsh(session: SshSession): Promise<void>;
```

- CLI層は利用者引数、ローカルツール、鍵と一時ファイル、終了コードを所有する。
- managed shell層はSDKからの認証・endpoint、公式WSS接続、`session_init`、bootstrap/control frameを所有する。
- proxy層はbootstrap完了後のbyte bridgeとbackpressureだけを所有する。AWS tokenをargv、URL query、context、一時ファイル、ログへ渡さない。
- image内helperはVMホスト鍵・接続専用authorized_keys・sshd設定・掃除を所有する。sshd/SFTP/rsyncをimageに導入し、既存healthサーバは維持する。

## 認証・プロトコル・並行接続の境界

AWS IAMはmanaged shellに入る権限、SSH鍵はsshdの認証を担う。既定SSHユーザーは既存node等の作業ユーザーとし、rootのmanaged shellはhelper起動にのみ使う。sshd設定は公開鍵認証のみ、パスワード・keyboard-interactive・root loginを無効とする。作業ユーザーのログイン可否、ホーム権限、PTY、SFTP subsystemはimage検証で確認する。

SSHは準備接続で取得したVMホスト鍵に固定する。`StrictHostKeyChecking=no` や「変わった鍵を無条件上書きする」は使わない。二つの接続の間でVMホスト鍵が変わった場合はSSHが失敗する。IAM shell権限を持つ主体がホスト鍵を書き換えられる点はこの信頼モデルの前提であり、SSH鍵がIAM shell権限より強い隔離境界になるとは主張しない。

WSS状態を `connecting → initializing → bootstrap → streaming → closing` として扱う。`session_init`は既知のtext制御frameとして解析し、PTY binaryをUTF-8文字列に変換しない。raw/noecho設定前のecho・prompt・helper応答はbootstrap専用の上限付きparserで消費する。nonce付きの明確な準備完了frame以降だけをSSHへ渡す。frame境界とSSH packet境界は一致しないため、分割・結合・同一frame内のbootstrap末尾＋SSH先頭を保持する。

helperへ渡す値は固定書式とbase64化した公開鍵等に限定し、VM IDやユーザー引数を無検証でshell文字列へ連結しない。ProxyCommandはOpenSSHによりローカルshellで解釈されるため、実行ファイルとcontextの絶対パスを厳密に引用し、空白・引用符・OpenSSHの%展開を含むパスをテストする。公開コマンドの任意SSHオプションでこの認証設定を上書きさせない。

接続開始・初期化・bootstrapには有限の期限を設ける。確立後の対話SSHへ既存管理操作の120秒制限をそのまま適用せず、必要なら明示的なセッション期限を別に持つ。OpenSSHのkeepaliveとWSS close/errorを監視し、接続断は非0へ伝える。TTY resize・Ctrl-CはSSHのプロトコルに任せ、外側managed PTYを対話端末としてresizeしない。

stdoutへの書込み完了とWSS送信queueを監視し、読み込みを停止/再開してメモリ上限を保つ。Bun native WebSocketに受信pause手段がない場合は、SSH自身のwindow制御だけに依存せず最大queueを決め、超過時は明確に失敗させる。低速受信・大容量転送で実用的な上限を満たせないなら、stream pause可能なWSS実装へ接続境界内で変更する。無制限queueやサイレントなbyte欠落は許さない。

## 完了条件と残る実証

- 2台のVMでホスト鍵が異なり、同一VM再接続では同じ鍵。2本以上の同時SSHが鍵・stdin/stdout・終了処理を共有しない。
- 対話SSH、非対話コマンドのstdout/stderr/終了値、PTY resize/Ctrl-Cが動く。正しいホスト鍵・公開鍵がない接続を拒否する。
- SFTPによるscpとrsyncで、全byte値を含む大容量ファイルの往復hashが一致する。低速readerでもbyte欠落・無制限メモリ増加がない。
- 接続失敗・資格情報の遅延・bootstrap timeout・WSS切断で呼出元へ戻り、トークンと秘密鍵を出力しない。転送失敗を再実行していないことを確認する。
- HTTP_INGRESS＋SHELL_INGRESSで既存health checkも維持し、検証用VMを終了する。

この候補は接続ごとにsshdを起動するためdaemon管理・固定待受port・共有client authorized_keysを省ける。代わりに各呼出しでホスト鍵確認用WSSと実データ用WSSの二段階、鍵生成、helper設計が必要になる。常駐sshdとローカル接続daemonは採らず、共有状態を減らすことを優先する。

参照済みOKFは `decisions/bun-microvm-cli`、`decisions/microvm-foundation`、既読のboundary-discipline、type-system-discipline、make-operations-idempotent、separate-before-serializing-shared-state。src/cli.tsとimage/Dockerfileのcode_refs検索で上記判断を確認した。設計候補の採否・統合・AWS実証・OKF更新は親へ返す。
