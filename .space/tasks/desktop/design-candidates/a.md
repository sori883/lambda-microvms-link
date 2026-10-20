# 候補A：VM内に画面サービスを置き、SSHで転送する

2026-10-20。独立候補・未採用・未実装。共通要件は `../task.md` のD1〜D5。他候補は参照していない。既存のBun CLI、名前付きセッション、SSH host pin、image 4.0を再利用する。今回の担当は設計だけで、製品コード・AWSを変更していない。

## 利用例

```sh
mvm session desktop demo
mvm session desktop demo --port 6082
```

初回はVMのデスクトップを起動し、手元のブラウザでnoVNCを開く。ターミナルには接続先セッションと「Ctrl-Cで画面接続を閉じる」を表示し、接続を維持する。XfceのChromiumから `http://localhost:3000` を開くと、同じVMの開発サーバーへ接続できる。

Ctrl-Cやブラウザタブの切断では、ローカル転送とその閲覧権限だけを終了する。VMとXfceは継続し、同じコマンドで同じ画面へ戻る。通常の `session stop` がVM全体の終了操作となる。Webの管理画面やローカル常駐daemonは作らない。

## 配置と責務

| 場所 | 構成・責務 |
| --- | --- |
| CLI | セッション・AWS account照合、既存永続SSH準備、ローカルポート確保、SSH転送、ブラウザ起動、閲覧lease更新・終了 |
| VMのsupervisor | デスクトップ一式の一度だけの起動、readiness、プロセス状態、同時attachの管理 |
| VMのXvnc | 仮想X画面。VNCは0600のUnix socketだけで受ける |
| VMのXfce・Chromium | `node` ユーザーの同一デスクトップ・ブラウザprofileを維持する |
| VMのwebsockify | WebSocketとRFBの変換。認証されていないブラウザから直接届かないUnix socketで待ち受ける |
| VMの小さなHTTP gateway | `127.0.0.1:6080` に限定し、noVNC静的資材と認証済みWebSocketだけを提供する |

既存SSHの `-L 127.0.0.1:<local-port>:127.0.0.1:6080` でgatewayへ接続する。新しいAWS HTTP公開ポート・ingress設定は追加しない。healthの8080番ポートと処理は維持する。

Xvncには `-rfbport -1 -rfbunixpath <private-path> -rfbunixmode 0600` を用いる。[BookwormのXtigervnc manpage](https://manpages.debian.org/bookworm/tigervnc-standalone-server/Xtigervnc.1.en.html) はTCP待受の無効化とUnix socketを提供する。websockifyもUnix listener/targetを提供するが、実装時は導入するDebian版のオプションを確認する。[websockify公式実装](https://github.com/novnc/websockify/blob/master/websockify/websocketproxy.py)

VM内のgatewayは既存Node.jsを利用し、HTTPの静的配信とUpgrade認証だけを所有する。承認後はwebsockifyのUnix listenerへ転送する。RFBや画面エンコードを独自実装しない。websockifyの公開TCPポートを残すと、VM内Chromiumの悪意あるページから認証を迂回できるため、gatewayだけをTCPの入口にする。

## 認証とブラウザ境界

ループバックbindだけを認証として扱わない。手元やVM内のブラウザが悪意あるページを開くと、ローカルWebSocketサービスへ接続を試みられる。

1. CLIは接続ごとに256bitのランダムcapabilityと閲覧IDを生成する。既存IAM認証・host pin確認済みSSHのstdinを通して、gatewayへcapabilityのhash、許可Origin、期限を登録する。秘密をimage・SQLite・一般ログへ固定しない。
2. WebSocket UpgradeのOriginとHostは実際に転送した `http://127.0.0.1:<local-port>` に完全一致させる。`localhost`、任意Host、`Origin: null`、Origin欠落、別ポート・別schemeは受け付けない。DNS rebindingや別サイトからのWebSocketを拒否する。静的HTTP GETは正しいHostで提供し、通常のページ遷移に存在しないOriginヘッダーは要求しない。
3. ブラウザへの最初のURLではfragmentにcapabilityを渡す。noVNC用の小さなwrapperが読み取り、直ちに `history.replaceState` で除く。HTTP query、Cookie、localStorageを認証に使わない。URL全体をCLI出力や診断ログへ書かない。
4. wrapperはWebSocket subprotocolでcapabilityを送る。gatewayは期限とhashを照合し、認証用protocolをbackendへ流さず、通常の `binary` protocolだけを中継する。noVNCは `wsProtocols` を指定できる。[noVNC公式API](https://novnc.com/noVNC/docs/API.html)
5. static wrapperは外部スクリプトを読み込まず、CSP、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` を付ける。受け取るパスを資材ディレクトリへ限定し、任意URLへのproxyを提供しない。

leaseは例えば120秒、CLIから30秒ごとにSSH制御チャネル経由で更新する。lease終了ではその閲覧IDのWebSocketだけを閉じる。秘密の照合・更新APIはブラウザHTTPへ公開せず、VM内のprivate Unix control socket経由とする。CLI終了時の明示revokeに失敗しても期限で閉じる。

ブラウザのページ再読み込みでcapabilityが失われた場合は、CLIから開き直す。ページが生存する間の通信断は同じleaseで再接続できる。同じOSユーザーのプロセスやIAMのVM管理権限を持つ主体からの隔離は約束しない。VM内のプロジェクトコードは既存と同じ `node` 権限の境界にある。

## 寿命、同時起動、失敗

supervisorはVM寿命のプロセス、SSH attachは閲覧寿命のプロセスとして分ける。XfceをSSHの終了signalに巻き込まない。VM内runtimeディレクトリは0700、control/VNC/WebSocket socketは0600とする。

デスクトップ初期化は既存 `flock` による短い排他で一度だけ行う。プロセスPIDだけで稼働判定せず、socketとgenerationを含むreadinessを確認する。起動途中の失敗は自分が起動したgenerationの子だけを終了し、別attachが使用するデスクトップを消さない。Xサーバーが落ちた場合の画面内容復旧は保証しない。自動再起動を繰り返して失敗を隠さず、状態を返す。

複数CLIは同じデスクトップへ独立した転送・leaseで接続する。VNCは共有接続とし、後から接続した利用者が既存接続を切らない。初版の画面サイズは固定（例1280×800）、表示側のscaleのみとし、複数閲覧者による解像度変更の競合を避ける。

ローカルポートは空き候補を選んで `ExitOnForwardFailure=yes` でSSH起動する。調査とbind間の競合は有限回だけ再選択し、明示 `--port` の競合はそのままエラーにする。転送先のreadinessを確かめてからブラウザを開く。起動待ちには既存setup timeoutを適用し、確立後の画面操作を同じ短いdeadlineで切らない。

ブラウザ起動失敗・SSH切断・VM終了は、安全な理由と再実行方法を返す。ブラウザ終了だけではCLIは終了せず、Ctrl-Cで閉じる。ローカル後始末は自分のSSH process groupとleaseだけを対象にする。ブラウザプロセス全体やVMを勝手に終了しない。

## 骨組み

```ts
type DesktopReady = {
  generation: string;
  gatewayPort: 6080;
  width: number;
  height: number;
};
type ViewerLease = {
  id: string;
  capability: Uint8Array;
  origin: string;
  expiresAt: number;
};
async function openSessionDesktop(
  session: SessionRecord,
  options: { port?: number; timeout: number },
  signal: AbortSignal
): Promise<void>;
```

`desktop` モジュールは既存session serviceと `prepareSessionSsh` を呼び、構造化されたready/statusだけを受け取る。VM helperの `ensure` と `attach` は同じsupervisorへ収束し、毎回別デスクトップを作らない。gatewayはブラウザ側のHTTP/WS認証、supervisorはVM内プロセスとleaseの所有を持つ。CLI側にnoVNC配布サーバーやWebSocket→RFBの実装を追加しない。

## ARM64・Chromium・資源制約

Debian BookwormのARM64には[Chromium](https://packages.debian.org/bookworm/arm64/chromium)と[TigerVNC](https://packages.debian.org/bookworm/arm64/tigervnc-standalone-server)がある。Xfce、dbus-x11、必要なフォント、Chromium sandbox、noVNC/websockifyもimageへ追加する。GPUなしの描画を想定し、headless ChromiumだけでGUIの完成を判定しない。

Chromiumはrootで起動せず、sandboxを有効にして検証する。[ChromiumのLinux sandbox](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux) はnamespace・setuid・seccomp等の利用可否に依存するため、Docker成功だけでMicroVM成功を保証できない。自動 `--no-sandbox` fallbackを入れない。実機で利用不能なら、原因と可能な隔離方法を設計へ戻す。

imageサイズ、起動時間、Xfce＋Chromiumのメモリ、`/dev/shm`、Xauthority/DBus/フォントを実測する。`--disable-dev-shm-usage` は必要性が測定された場合の選択肢とし、無条件には付けない。VM内ChromiumのprofileはVM寿命まで保持し、異なるVMには引き継がない。

## 検証と比較上の不利益

- Docker ARM64で起動・同時ensure・readiness失敗・再attachを検証する。imageのhealth、SSH、VS Codeの経路も維持する。
- 認証なし、誤capability、期限切れ、別Origin/Host、HTTP queryへのtoken、外部interfaceからの接続を拒否する。VM内Chromiumの悪意あるページからgatewayを操作できないことも確認する。
- 2閲覧接続のうち一方を終了しても、他方とXfceが継続する。CLI強制終了時はlease期限で閉じ、再実行で同じ画面へ戻る。
- 実AWSでsandbox有効なChromium、開発サーバー表示、キー入力・クリックによるDOM結果、切断後の画面継続を確認する。スクリーンショットだけで入力成功としない。
- socket/転送のbackpressure、大きな画面更新、切断時の子プロセス終了、秘密を含まないログを検証する。

Aの利点は、GUI資材と対応バージョンをimage内へ閉じ、ローカルにはBun・OpenSSH・ブラウザだけを求めること。VM側にgateway、Python/websockify、lease管理が増え、noVNC修正でもimage更新が必要になる。認証gatewayを省いて無認証websockifyをSSH転送する案は、ブラウザからのローカル接続を境界に含められないため採らない。

親の共通spikeでは、Dockerの通常seccompでnamespace作成がEPERMとなり、試作コンテナだけseccompを解除するとnodeユーザーのsandbox有効ChromiumでDOM取得が成功した。AWS image 4.0では追加OS capabilityなしのnodeユーザーで `unshare -Ur true` が成功した（`../evidence/namespace-probe.json`、検証VMは親が終了済み）。後者はuser namespace利用の証拠で、Chromium全体のsandbox動作確認ではない。

残件はMicroVM上のChromium sandbox、実メモリ・起動時間、Debian版noVNC/websockifyのAPI適合、gatewayとUnix backendの実経路である。親の共通spikeを再利用し、今回の案だけでこれらを確認済みとはしない。
