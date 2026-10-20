# 候補B: SQLiteを正本にして接続設定を必要時に生成する

2026-10-20。独立候補・未採用・未実装。他候補は未参照。対象はHEAD `657ca21` と現在の `src/cli.ts`、`src/microvms.ts`、`src/ssh.ts`。devlowの設計工程として現状確認と整合性確認を行い、実装・AWS操作は行っていない。

## 利用例と契約

```sh
mvm --profile dev --region ap-northeast-1 session create demo --project ./work/test --image dev-image
mvm session create trial --project ./work/test --image dev-image
mvm session list
mvm session list --refresh --json
mvm session ssh demo
mvm session code demo
mvm session stop demo
mvm session recover demo --id microvm-...
```

名前は端末の利用者単位で一意とし、同じprojectに複数の名前を登録できる。名前はASCII小文字・数字・ハイフンで入力境界を制限する。projectは作成時の実在ディレクトリをrealpathで記録する。これは所属情報であり、自動同期やローカルディレクトリのマウントは意味しない。リモート作業場所は `/workspace`。

1セッションは一度だけ1VMへ結び付く。終了後に同名createを繰り返しても新VMを作らず、既存の終了状態を返す。新規VMには別名を使う。既存のID指定コマンドは維持し、名前解決は `session` 配下だけに置く。

listの既定はローカル一覧で、AWS観測状態には観測時刻と古い可能性を表示する。`--refresh` は保存された接続先を照会し、接続できない行をUNKNOWNと理由付きで返す。AWS側のVM一覧を自動的にセッションへ取り込まない。create/list/stop/recoverは既存JSON出力契約を使い、ssh/codeはストリームまたはGUI起動としてJSONを受け付けない。

## データと責務

SQLiteは「利用者が付けた名前・起動意図・VMへの結び付け・host pin」の正本。VMの実際の状態はAWSが正本であり、DBのRUNNINGを接続可能の証拠にしない。Bun標準の `bun:sqlite` を使い、常駐プロセスや新しいAWS基盤は追加しない。[Bun SQLite](https://bun.sh/docs/runtime/sqlite)

```ts
type AwsTarget = {
  partition: string; accountId: string; region: string;
  credentials: { kind: "default-chain" } | { kind: "profile"; name: string };
};
type Binding =
  | { kind: "prepared"; clientToken: string; request: FrozenRunInput }
  | { kind: "request-unknown"; clientToken: string; request: FrozenRunInput }
  | { kind: "bound"; vmId: string };
type Session = {
  id: string; name: string; projectPath: string; target: AwsTarget;
  binding: Binding; desired: "running" | "terminated"; revision: number;
  hostPin?: string; sshGeneration?: string;
  observed?: { state: string; at: string; expiresAt?: string };
};
interface Sessions {
  create(input: CreateInput): Promise<Session>;
  list(refresh: boolean): Promise<SessionView[]>;
  prepareConnection(name: string): Promise<PreparedSsh>;
  recover(name: string, vmId: string): Promise<Session>;
  stop(name: string): Promise<Session>;
}
```

- `session-store` はschema version、UNIQUE(name)、UNIQUE(partition, accountId, region, vmId)、状態遷移とrevision付き更新を所有する。SQLite内部表現をCLIやSSH層へ漏らさない。
- `sessions` はDBとAWSの間の復旧手順を所有する。既存Microvmsを再利用するが、起動前にimage ARNと具体的image versionを解決し、Run入力を固定して保存する処理を分離する。
- `session-ssh` はDB上の対象とpinから専用SSH設定を生成する。既存 `sshConfig` と公開鍵付きproxyを再利用し、隠し `session-proxy <session-id> <generation>` でDBの対象を再検証する。
- `session-code` はVS Codeへの設定受け渡しだけを所有する。SSHやAWSの別実装を持たない。

データはproject外の利用者専用領域、例えば `~/.local/state/mvm/` に置く。親ディレクトリ0700、DB・鍵・設定0600とし、SQLiteのWAL/SHMにも同じ所有境界を適用する。AWS資格情報、SSO情報の複製、shell token、秘密を含む環境変数はDB・設定・ログへ書かない。profile名は参照情報として保存できる。

## 接続、鍵、VS Code

初回ssh/code時にローカルEd25519鍵を生成し、IAM認証済みmanaged shellからhost keyを取得してDBへ一度だけpinする。接続設定とknown_hostsはDBから導出する。秘密鍵はDBのjournalへ入れずセッション専用ファイルに置き、セッションの終了まで保持する。OpenSSHが使うIdentityFileを接続開始前に用意する必要があるため、proxy起動後に毎回別鍵を生成する構造は採らない。

鍵・設定はUUIDの世代別ディレクトリへ完成させた後、DBのgenerationをCASで公開する。同時初回準備は一つだけ採用し、敗者は自分の未公開ディレクトリだけを消す。公開済み世代は接続準備中に置き換えず、DBと一致しない世代のproxyは接続を拒否する。専用の安定configパスはatomic renameで更新する。DB公開後のconfig欠落は次回ssh/codeで同じ世代から修復する。

HostKeyAliasには名前ではなくpartition/account/region/VM IDを使い、StrictHostKeyChecking=yesを維持する。再接続時は保存pinを使用し、鍵不一致を自動更新しない。IAMの権限がある主体はVM rootへ入れるという現在の信頼境界を維持する。

各proxyはSDK標準credential chainで必要時に資格情報を解決し、STSでaccount/partitionを確認してから、同じ解決済み資格情報と保存regionでMicroVMを確認する。資格情報の更新時も対象確認を必要とする。profile差し替えやambient環境の変更で別accountへ向いたら、VM操作前にTargetMismatchで停止する。profileを指定しなかった場合も環境・shared files・role等の標準chainを保ち、SSOへ限定しない。

接続ごとに有効期限1分のshell tokenを新規取得し、メモリ内だけで既存managed WebSocketへ渡す。VM内sshdは現在と同じ接続単位、ローカル鍵だけがセッション単位。VS Codeによる複数同時SSHでもauthorized_keysを共有しない。

`session code` はセッション専用 `--user-data-dir` のUser設定に `remote.SSH.configFile` を設定し、`code --user-data-dir <managed-dir> --new-window --remote ssh-remote+<session-alias> /workspace` を起動する。CLIが終了しても設定と鍵を残すためsleepは不要。通常のVS CodeのUser設定、既存 `~/.ssh/config`、projectの `.vscode` は変更しない。専用User設定を後で利用者が編集した場合は所有キーだけを照合・更新し、他キーを保持する。公式CLIは専用user-data-dirとremote指定を提供する。[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line)

`remote.SSH.configFile` はUser設定として扱う。親が確認したRemote-SSH 0.128.0ではapplication scopeであり、workspace設定では代用しない。専用領域にはRemote-SSHの有効化・導入確認が別途必要となり、通常環境のテーマや拡張がそのまま揃うとは約束しない。[Remote-SSH設定](https://code.visualstudio.com/docs/remote/ssh)

GUI再接続時もAWS認証を行う。SSO期限切れならログイン後に再接続、環境資格情報しかない場合はその環境から専用VS Codeを起動する。既に動いている同じuser-data-dirのプロセスは古い環境を持つため、環境を更新しただけでは直らず、その専用インスタンスを終了して起動し直す。SDKの認証方式を変更したり資格情報を設定へ埋め込んだりして回避しない。[VS Codeの環境継承](https://code.visualstudio.com/docs/configure/command-line#_isolating-vs-code-instances)

## 中断、同時実行、期限切れ

1. createは検証済みtargetと固定Run入力、client tokenを短いDBトランザクションで予約する。Runを送る直前にrequest-unknownを確定し、応答を受けたらVM IDを保存する。ネットワーク待ちの間はSQLite write transactionを保持しない。
2. 同名同時createはUNIQUEとCASで一つだけRun送信へ進む。既存preparedは再開可能、request-unknownは自動再送しない。AWSのclientToken保持期間が確認できていないため、時間を置いた同じtokenの再送でも重複VMを防げると仮定しない。
3. 起動結果不明では `recover demo --id ...` で既存VMへ結び付ける。target、image ARN/version、起動時刻範囲、最大寿命、他セッションへの未所属を照合する。同条件のVMが複数ならこれだけで起動要求との同一性は証明できないため、利用者が指定したIDを復旧対象とすることを明示する。手掛かりのないVMを推測で採用・終了しない。
4. stopはdesired=terminatedを先に保存してから既存のterminateを呼ぶ。create進行中にstopが来ても起動を再開せず、応答でIDを得た処理が終了要求へ収束する。結果不明ならrecover後にそのVMを終了する。終了確認まで秘密鍵と復旧情報を保持し、確認後にSSH秘密鍵・生成設定を削除して履歴行を残す。
5. VM最大寿命は説明用の推定期限として表示する。接続時にはAWSを照会し、TERMINATEDなら終了済みとして接続を拒否する。寿命切れでも自動再作成・Suspend/Resume・コマンド再実行はしない。認証期限切れや通信失敗をVM終了と取り違えない。
6. DBはWALと短いbusy timeoutを用い、競合時は明示的な再試行可能エラーを返す。並行SSHは読取り中心で共有lockを長時間持たない。SQLite transactionの外にあるAWS副作用とファイル公開は原子的にならないので、上記状態遷移と世代照合で回復する。DB破損は自動初期化せず、既存ID指定操作でAWS側を確認できるようにする。

## 利点、不利益、確認方法

名前の一意性、VMの二重所属禁止、途中起動の記録を一つのトランザクション境界にまとめられる。GUIの寿命をCLI親プロセスへ結び付けず、daemonの監視・ソケット・自動起動も不要。共有するのはセッション台帳だけに絞る。

一方、少数セッションのためにschema migration、DB障害対応、DBとファイルの整合回復を導入する。全sessionのmetadataが一DBへ集中する。永続SSH秘密鍵の管理と専用VS Code環境の初期設定も必要。メモリ内鍵を保持するdaemon案は秘密鍵のディスク保存を避けられるが、daemon再起動・agent互換・ソケット認証・GUI再接続の寿命管理が増えるため、この候補では採らない。

受入確認は、同projectの2session、同名同時createのRun1回、Run前後/DB保存前後の強制終了、結果不明の自動再送禁止、recover後の一意性、createとstop競合、host pin不一致、profileのaccount変更拒否、token未保存、同時SSH、CLI終了後のGUI再接続、停止後の再接続拒否を対象にする。SQLiteは実ファイルと複数CLIプロセスで検証し、AWS境界は障害注入する。SSHは既存Docker実経路を再利用し、最後にAWSとVS Codeで通常User設定・SSH設定のバイト不変を含めて確認する。

現時点では設計の自己確認のみ。専用user-data-dirでのRemote-SSH導入と再接続、環境資格情報更新後のGUI挙動、compiled Bun実行物でのSQLite運用は実装前または実装中の実証が必要。既存SSHの実機成功と今回のセッション機能の成功は区別する。

根拠は `decisions/ssh-over-websocket`、`decisions/bun-microvm-cli`、`principles/make-operations-idempotent`、`principles/separate-before-serializing-shared-state`。前者の一時設定は今回のGUI継続要件に合わせて変更するが、既存ID操作の寿命契約は維持する。未採用候補のためOKFへは保存せず、採否と確定知識の保存は親へ渡す。
