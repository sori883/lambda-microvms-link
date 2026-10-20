# 候補B：VM内の持続sshdとOpenSSH設定を使う

2026-10-20。担当 `/root/cli_design_b`。設計のみ、未採用・未実装。他候補は未参照。WebSocket方式はユーザー承認済みとして引き継ぐ。

## 利用例

```sh
mvm ssh-config <vm-id> --identity ~/.ssh/id_ed25519 --output ./vm-ssh.conf
ssh -F ./vm-ssh.conf vm
ssh -F ./vm-ssh.conf vm 'cd /workspace && bun test'
scp -F ./vm-ssh.conf ./source.txt vm:/workspace/source.txt
sftp -F ./vm-ssh.conf vm
rsync -a -e 'ssh -F ./vm-ssh.conf' ./src/ vm:/workspace/src/
```

`ssh-config` は明示VM IDへIAMで接続し、SSH公開鍵の登録、sshdの準備、host公開鍵の取得を行って専用のOpenSSH設定を生成する。鍵の秘密部分は転送しない。設定は明示した出力先にのみ作り、利用者の `~/.ssh/config` は変更しない。生成先の隣に、VM IDごとのknown_hostsを保存する。設定にはAWSプロファイル名・リージョン、identityの絶対パス、CLIの絶対パスを含めるが、AWS資格情報・トークンは含めない。

## 配置と接続の流れ

1. イメージにはOpenSSH server、ssh-keygen、rsync、初期化・TCP bridge用の小さな自作プログラムを含める。healthアプリは維持する。**ビルド／snapshot前にhost keyを作らず、sshdも開始しない。**
2. `ssh-config` がGetMicrovmでRUNNINGと接続先を確認し、8022番だけの短命tokenを発行する。親が確認した `/shell` とsubprotocols `token,lambda-microvms`、`session_init` に従って初期化プログラムを起動する。
3. VM側の初期化はroot所有の `/run/mvm-ssh/` で、一度だけhost keyを生成し、`127.0.0.1:2222` にsshdをdaemonとして起動する。SSHログイン先は一般ユーザーとし、public-key認証だけを許可する。初期化後のWSを閉じてもsshdは残る。
4. 通常のssh/scp/sftp/rsyncはOpenSSH自身が処理する。生成設定の `ProxyCommand` は `mvm ssh-proxy <vm-id> ...` を起動し、毎回新しいIAM tokenでWS shellを開く。shell内でPTYをraw・echo無効にして、既存sshdへのTCP bridgeへ置き換える。OpenSSHのバイト列だけを相互転送する。
5. WSは管理されたshellの8022番を使い、sshdの2222番を外部ingressへ公開しない。起動時のコネクターは親の実機結果に従いHTTP_INGRESS＋SHELL_INGRESSへ変更する。ALL_INGRESSだけではshell tokenが発行できなかった。

接続ごとにSSH serverを起動する構造と異なり、server設定・host key・認可鍵・listen socketをVM寿命中の一つのサービスが所有する。各WS接続は既存TCPサービスへ接続する責務だけを持つ。

## 骨組みと所有する状態

```ts
type VmTarget = { microvmId: string; region?: string; profile?: string };
type PreparedSsh = { user: string; hostPublicKey: string; hostKeyFingerprint: string };

prepareSsh(target: VmTarget, userPublicKey: string): Promise<PreparedSsh>;
writeSshConfig(target: VmTarget, prepared: PreparedSsh, identity: string, output: string): Promise<void>;
proxySsh(target: VmTarget, io: { stdin: Readable; stdout: Writable }): Promise<number>;
```

- `src/managed-shell.ts`：token発行、WS handshake、session_init、テキスト制御／バイナリpayloadとmap headersの検証、流量制御、切断。
- `src/ssh.ts`：初期化要求と応答、OpenSSH設定・known_hosts生成、ProxyCommand用の入出力契約。SSH暗号やSFTP／rsyncプロトコルは実装しない。
- VM側helper：host key、認可鍵、sshd設定、daemonの生存確認と起動を所有する。bridgeはTCP／PTYのbytesとEOFだけを扱う。

利用者入力をshell文へ直接連結しない。固定コマンドと検証済みのデータ形式で公開鍵を渡す。OpenSSH設定とProxyCommandは改行・引用符・空白・`%`を含むパスを各形式に合わせて扱う。proxyのstdoutはSSH通信専用で、進捗・JSON・例外文を混ぜない。

## IAM、SSH認証、host key

AWS認証は既存SDK標準チェーンを維持する。IAMは管理shellへ入る権限、SSH公開鍵はsshdがユーザーとして受け入れる条件を担う。管理shellでrootを取得できるIAM主体は認可鍵を書き換えられるため、SSH鍵をその主体に対する独立した隔離境界とは説明しない。

host公開鍵は、初期化のIAM認証済みWS経路から取得し、生成設定の専用known_hostsへ固定する。`StrictHostKeyChecking yes`、VM ID・リージョンを区別したHostKeyAlias、指定IdentityFileとIdentitiesOnlyを使う。以降の接続でhost keyが変わったら失敗する。既存pinを再実行で黙って上書きしない。

host秘密鍵はVM起動後の初回初期化で生成し、同一VMではsshd再起動後も保持する。別VMが同じhost keyを持たないことを検証する。snapshotに秘密鍵を含めない。利用者鍵の登録は既存の鍵を消さず、鍵指紋で重複を避ける。VM寿命中の一般ユーザーによるキー管理を認めるかは固定したsshd設定へ明示する。

## 並行接続と失敗

初期化だけをVM側の一つのロックで直列化する。root所有の設定・PID・実際のlisten状態を照合し、既存daemonを再利用する。PID番号だけで別プロセスをkillせず、古いロックを時刻だけで解除しない。複数の公開鍵追加は原子的に反映する。通常のSSH接続はそれぞれ別WS／TCP接続で、並行実行を妨げない。

接続準備には期限を持たせる。確立後のSSHセッションへ既存CLIの120秒一律タイムアウトを流用しない。SSH側のkeepalive、VM最大寿命、WS切断を別々に扱う。token期限切れで既存WSがどう扱われるかは実機確認事項とし、無制限の長時間接続を保証しない。

初期化失敗は構造化エラー、proxy失敗はstderrと非0終了で返す。TCP拒否、WS protocol不正、ホスト鍵不一致、認証失敗を区別できる。WS切断・ローカル終了では当該bridgeを終了し、共有sshdや他のSSH接続は止めない。切れたSSHやrsyncコマンドを自動再実行しない。VM停止は既存の明示ID `stop` に任せる。

## 利点、追加コスト、受け入れ条件

利点はOpenSSHの標準的なserver配置と既存クライアントをそのまま利用でき、接続を増やしてもsshd設定・host keyの所有者が増えないこと。SFTP subsystemとrsyncを同じ経路で利用できる。

代償は持続daemon、listen port、初期化ロック、認可鍵更新、専用設定／known_hostsの管理が必要になること。daemon障害は全新規接続へ影響する。接続終了時に全VM側プロセスが消える構造ではない。初版の少数接続では、この固定費が利点を上回る可能性がある。

採用時に確認する条件：

- 実機でssh対話、遠隔コマンドのstdout／stderr／終了コード、SFTPによるscp往復、rsync往復を行い、バイナリファイルのSHAが一致する。
- 2接続を並行に開始してもhost keyが一つに定まり、片方の切断がもう片方とdaemonへ影響しない。
- snapshotから作った別々のVMのhost keyが異なる。同じVMでは再接続／daemon再起動で一致し、意図的な鍵変更は検出される。
- IAM拒否、SSH鍵不一致、daemon不在、TCP拒否、WS途中切断、遅い送受信、EOFと半閉じを確認する。トークン・秘密鍵が出力や生成設定へ残らない。
- shellはrootかつ現行Alpine/app内と親の実機probeで確認済み。追加したsshdがその環境で動き、PTYの制御文字変換がSSHバイト列を壊さず、終了済みVMでは接続が失敗することを確認する。

## 根拠と限界

親の実機probeで現行image1.0のmanaged shellはuid0/root、Alpine/appのserver.mjsが見え、Bun native WSのtext session_initとbinary PTYが成立した。ALL_INGRESSのみのtoken発行はValidationException、probeVMは終了済みと報告を受けた。本担当自身はAWS操作をしていない。

現行src/cli.ts、image/server.mjs、DockerfileとOKFのdecisions/bun-microvm-cli、decisions/microvm-foundationを照合した。ルール0件・全原則のdescriptionを確認し、前工程で読んだboundary-discipline、make-operations-idempotent、type-system-discipline、separate-before-serializing-shared-stateを再利用、test-behavior-not-implementationとprove-it-worksの本文を追加確認した。

サンプル `aidansteele/microvm-fun` はLICENSEなしとの引き継ぎに従い、コードを参照・コピーしていない。上記は利用例と所有境界の独立設計で、sshd／bridge／生成設定の実装・動作は未確認。WSフレームの正確な形式、PTY制御とEOF、鍵生成時のsnapshot整合、token期限後の既存接続、Bunの長時間転送とバックプレッシャーは実装前後の試作で確定する。
