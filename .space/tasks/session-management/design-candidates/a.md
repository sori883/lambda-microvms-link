# 候補A：セッションごとのファイルと操作記録

状態：独立設計候補。未実装。2026-10-20 の既存 Bun CLI、`decisions/bun-microvm-cli`、`decisions/ssh-over-websocket` を前提とする。他候補は参照していない。

## 利用例と今回の範囲

```sh
mvm session create demo --project ./work/test --image <name-or-arn> --profile development
mvm session list
mvm session ssh demo
mvm session ssh demo -- pwd
mvm session code demo
mvm session stop demo
mvm session recover demo --id <vm-id>
```

一つの名前付きセッションが一つのVMを所有する。同じローカルプロジェクトから複数セッションを作れる。既存のID指定コマンドは維持する。`--image` は既存の選択方法を引き継ぎ、未定義のデフォルトを推測しない。

`--project` は実在するローカルディレクトリの関連付けで、作成時に絶対パスへ解決する。初版は自動アップロードしない。SSH・VS Code の開始先は既存imageの `/workspace` とする。Suspend/Resume、同期、クラウド側の管理リソースは追加しない。

CLIが終了しても名前・VM・SSH鍵・接続設定を保持し、VMが有効な間は同じ対象へ再接続できることを完成条件とする。接続設定の永続性と、外部のAWS資格情報が有効であることは分けて扱う。

## 保存先と責務

```text
~/.mvm/sessions/<name>/             0700、名前は安全な短いslugに制限
  session.json                    0600、schemaVersionと不変のsessionId
  operation.json                  0600、進行中のcreateまたはstop
  identity / identity.pub         セッション寿命のSSHクライアント鍵
  known_hosts                     IAM経路で取得したVMのhost key
  ssh_config                      絶対パスを含む安定した接続設定
  vscode/User/settings.json       専用VS Codeインスタンスの設定
```

`session-store` は検証、権限、原子的な保存、同一セッションの排他だけを所有する。`sessions` は作成・状態更新・停止・復旧を所有する。`session-ssh` は鍵・設定の準備と既存SSH処理への接続を所有する。AWS通信と認証は親の共通基盤 `sessionAws` と `Microvms` を再利用する。

一覧はディレクトリを列挙する。全セッションを含む別の可変indexや常駐daemonを持たず、無関係なセッションの操作を直列化しない。

```ts
type Binding = { accountId: string; region: string; profile?: string };
type Phase = "creating" | "unknown" | "ready" | "stopping" | "stopped";
type Session = {
  schemaVersion: 1;
  sessionId: string;
  name: string;
  project: string;
  remotePath: "/workspace";
  binding: Binding;
  phase: Phase;
  vmId?: string;
  imageArn: string;
  imageVersion: string;
  createdAt: string;
  lastObserved?: { state: string; at: string };
};
type Operation =
  | { kind: "create"; startedAt: string; request: RunMicrovmRequest }
  | { kind: "stop"; startedAt: string; vmId: string };
```

実装では `phase` と `vmId` の関係を判別可能unionにし、`ready/stopping/stopped` でIDが欠ける状態を禁止する。起動準備済みrequestに固定clientToken・解決済みARN・imageVersionを含める。

## 作成、同時操作、途中停止

1. 名前、project、image、認証を検証し、STSで実際の利用accountを取得する。image所有accountから推測しない。
2. 名前の予約はexclusive作成で行い、同名createは片方だけ成功する。既存recordを上書きしない。
3. `prepareStart(options, true)` の結果とclientTokenを操作記録へ耐久保存してから、`runPrepared(request)` を呼ぶ。
4. API応答のVM IDを直ちに保存してから `waitFor(id, "RUNNING")` を実行する。IDの保存を待機完了まで遅らせない。
5. SSH鍵・host pin・configを準備して `ready` を保存し、操作記録を除く。

JSONは同一ディレクトリの一時ファイルへ書き、flushしてrenameする。recordを確定した後で操作記録を消すため、残った操作記録から中断箇所を判断できる。schema不明・破損ファイルを空recordに置き換えない。

排他はセッション単位で、create/recover/stop/config更新の間だけ保持する。SSH接続の全寿命にわたるlockは取らない。初版の実装選択はOS advisory lock、またはowner付きexclusive lockとする。後者では時間経過だけでlockを奪わず、owner死亡を確認できない場合は明示エラーにする。PID再利用・stale lockの扱いは実装時に検証する。

Runの応答が不明なら `unknown` を保持し、後日自動再送しない。[RunMicrovm API](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html) はclientTokenの冪等性を説明するが、保持期間は記載していない。初版は既存tokenの無期限再利用を保証として扱わない。

`recover --id` は利用者が選んだVMを、保存account・region、image/version、起動時刻との整合を検査して関連付ける。候補を最近のVM一覧から自動選択しない。整合チェックはそのVMが元のRun結果であることの完全な証明ではなく、明示したIDを採用する操作として表示する。既にIDを保存済みなら別IDへ変更しない。

## 認証、SSH鍵、GUI

各操作は保存regionとprofile参照を使い、現在のSTS accountが保存accountと一致した場合だけ進む。default chainは維持し、profile未指定の場合にSSOへ限定しない。`AWS_PROFILE` を採用するときは非秘密のprofile名だけ保存する。秘密AWS資格情報、認証token、環境変数の一括コピーは保存しない。非標準のAWS config/credentialsファイルを使う場合も、その非秘密のパス参照だけを保持する。

STS照合と対象APIが別のcredentialを使用しないよう、共通基盤で同じ解決結果を使用する。credentialの更新・再解決時にはaccountを再確認する。拒否や期限切れはセッションを残した認証エラーであり、VM終了扱いにしない。

SSH aliasは表示名でなく `mvm-<sessionId>` にする。同名セッションの作り直しが古いVS Code窓を別VMへ接続させることを防ぐ。host keyは既存のIAM-authenticated WSSで取得し、`StrictHostKeyChecking yes` で固定する。再接続時に不一致を自動上書きしない。

ProxyCommandは不変sessionIdを指定する専用内部コマンドを呼び、保存状態とaccountを検査してから短命tokenを取得する。raw VM IDだけを設定に埋めて認証境界を迂回させない。既存の接続ごとの `sshd -i` を再利用し、同時SSHを許す。クライアント秘密鍵は0600、tokenはメモリ内だけとする。

CLI実行パスを絶対パスで保持する。spaces・quotes・`%` は既存のOpenSSH向けescapeを使う。CLI移動時はVMやpinを置換せず、launcher設定だけを再生成する。

`session code` はセッション専用 `--user-data-dir` を使用し、そのUser設定で `remote.SSH.configFile` を安定したssh_configへ向ける。親が確認したRemote-SSH 0.128.0ではこの設定はapplication scopeなので、workspace設定へ書かない。

```sh
code --user-data-dir <session-directory>/vscode \
  --remote ssh-remote+mvm-<sessionId> /workspace
```

[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line) の独立user-data-dirを利用するため、既存のVS Codeが保持する古い環境・一時configへ依存しない。利用者の通常のVS Code設定や `~/.ssh/config` は変更しない。専用環境のRemote-SSH拡張準備と設定分離の使い勝手は親の実証結果で確定する。接続設定の指定方法は[Remote-SSH公式文書](https://code.visualstudio.com/docs/remote/ssh)を参照する。

環境変数だけの一時資格情報は、新しいGUIプロセスで再取得できるとは限らない。初回環境を保存して解決する方式は採らず、再接続不能ならprofileやcredential_process等の再解決可能な認証元を案内する。ターミナルからのSDK標準認証は引き続き利用できる。SSOの再ログインは外部の認証手続きであり、VMを作り直さない。

## 一覧、期限切れ、停止と復旧

| 条件 | 振る舞い |
| --- | --- |
| list | 名前・project・account/region・VM ID・前回確認状態と時刻を表示。更新結果とキャッシュを区別する |
| 起動待ち/SSH準備失敗 | 保存済みIDと操作記録を残し、同じVMで再開。新規Runに切り替えない |
| AWS認証/通信失敗 | unknown/unavailableを表示し、終了や存在しない状態と混同しない |
| VMの寿命到達 | 時刻だけで断定せず、AWSの終了状態を確認して接続不可を表示 |
| stop | stop intentを保存、同じIDを終了し、終了確認後にSSH秘密鍵・config・pinを削除 |
| stopのtimeout | ID・鍵・操作記録を残し、再実行で終了確認を続ける |
| 既に終了済み | stop成功として非秘密の終了recordを残す |
| VS Codeが起動中 | SSH終了は起きるが、GUIプロセスを勝手にkillしない。使用中のuser-data-dirは再帰削除しない |

認証済み同一account/regionでの明確なNotFoundのみ、外部終了として扱えるかをAPI実装時に確認する。AccessDeniedをNotFoundへ変換しない。終了後の同名createは初版で自動許可せず、終了recordの明示削除・置換が必要なら別操作として追加する。

## 確認すべき振る舞いと未確認

- 同名create競合でRunが一度だけになり、別名操作は並行できる。
- Run直前、応答直後、ID保存後、鍵作成途中、終了API後で中断しても、再操作が別VMを作らない。
- account mismatch・credential refresh・不正regionの経路で対象APIを送らない。
- 同じVMに複数SSH/VS Code接続でき、CLI終了・再起動後も同じaliasとpinを使う。
- host key不一致、秘密ファイルの不適切権限、破損record、stale lockで安全に失敗する。
- VM期限切れ・認証期限切れを区別し、stopの再実行と終了後の秘密鍵削除が成立する。
- 専用VS Code環境で拡張準備、Remote-SSH再接続、projectとの関連表示を実操作確認する。

AWSのidempotency保持期間は不明なので自動再送しない方針で閉じる。lockの実装方法、GUI拡張配置、NotFoundの厳密な扱いは実装・実証時の残件。`--project` にファイル転送を含めない前提はユーザー向け説明へ明記する。

## 採らない構造と判断理由

中央DBやdaemonは、現在必要な一セッション内の排他・復旧に対して運用負担が増えるため採らない。操作journalは進行中の一操作に限定し、イベント履歴基盤にしない。

クラウド側のsession管理リソースは導入せず、他端末との同期は保証しない。AWSをVM状態の正本、ローカルを名前・設定・操作意図の正本として分ける。環境全体の保存やGUIの既存プロセスへ秘密資格情報を埋め込む方式も採らない。

適用原則はboundary-discipline（認証・保存・AWS状態の境界）、make-operations-idempotent（保存後に操作、未知結果からの重複防止）、model-the-domain/type-system-discipline（不変sessionIdと状態）、separate-before-serializing-shared-state（セッション単位の排他）、experience-first（名前で再接続）を継承した。候補の整合性を確認した段階であり、実装・AWS操作は行っていない。
