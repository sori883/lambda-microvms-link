# 候補B: ローカルBunがnoVNCを提供し、SSHの標準入出力でVNCへ接続する

2026-10-20。独立候補、未採用・未実装。他候補未参照。共通要件は `../task.md` D1–D5。現行image4.0、`src/session-ssh.ts`、`src/ssh.ts`、`image/mvm-sshd` と既存OKFの名前付きセッション・SSHの決定を確認した。製品コードとAWSは変更していない。

## 利用例

```sh
mvm session desktop demo
```

名前に対応するVMを照合し、デスクトップを準備して手元のブラウザを開く。CLIは接続を提供する間動き続け、Ctrl+Cで手元の接続だけを終了する。再実行すると同じVMのデスクトップへ戻る。ChromiumはVM内で動き、そのアドレス欄の `http://localhost:3000` はVM内の開発サーバーを指す。初版は画面と「接続中／切断／再接続」だけを提供し、VM管理のWeb UIは作らない。

CLIの出力はsession名と接続状態。ブラウザを開くURLの秘密fragmentは通常ログへ出さない。ブラウザ起動に失敗した場合は明確なエラーでローカル接続を片付ける。手動URL表示は別の明示オプションとして追加する場合だけ扱い、通常のJSON・診断出力へ混ぜない。

## 構造と型

```text
手元ブラウザのnoVNC
  → http/ws 127.0.0.1:ランダムポート
  → Bunの認証済みWSとSSH標準入出力の中継
  → ssh -F <既存の永続config> -W 127.0.0.1:5901 <session alias>
  → 既存AWS managed shell / sshd -i
  → VM内loopbackのTigerVNC → Xfce / Chromium
```

VMが持つのはX、VNC、デスクトップとアプリ。noVNCのJavaScript、HTML、HTTP、WebSocket変換はCLI側が所有する。AWSの公開ポート、HTTP ingress設定、新しいAWS基盤を追加しない。ブラウザへAWS資格情報・トークン・SSH秘密鍵を渡さない。

```ts
type DesktopInfo = { protocol: 1; display: ":1"; port: 5901; generation: string };
type DesktopConnection = {
  origin: string;
  open(): Promise<void>;
  close(): Promise<void>;
};
ensureDesktop(ssh: PreparedSessionSsh, signal: AbortSignal): Promise<DesktopInfo>;
serveDesktop(ssh: PreparedSessionSsh, info: DesktopInfo, signal: AbortSignal): Promise<DesktopConnection>;
```

- VMの `mvm-desktop ensure` が画面プロセスの起動・再利用と状態確認を所有する。固定ポートはhelperの出力を信頼して任意転送するのではなく、CLIでprotocolと5901を検証する。
- `src/desktop.ts` 相当が認証済みセッション準備、helper呼出し、ローカルHTTP/WS、子SSHの寿命を所有する。既存のSSH configとhost pinをそのまま使う。
- browser wrapperはnoVNCのRFB APIを呼び、画面と再接続状態を表示する。RFBの再実装はしない。WS接続はRFBストリームを渡せる公式APIに基づく。[noVNC API](https://novnc.com/noVNC/docs/API.html)
- WebSocket一つにSSH子プロセス一つを対応させる。`ssh -W` は接続先への標準入出力転送を提供するため、手元の裸VNCポートや `ssh -L` のポート予約競合を作らずに済む。[OpenSSH ssh](https://man.openbsd.org/ssh.1)

## VMの寿命と同時起動

nodeユーザーとしてTigerVNC、Xfce、session D-Bus、Chromiumを動かす。TigerVNCは `127.0.0.1:5901` のみ、X11はTCP待受を無効にする。外部から画面操作できる経路は認証済みSSHだけで、VNC自体はVM内の同じユーザー境界に置く。VNC認証なしを使う場合も、loopback限定とSSH認証が条件であり、外部待受への設定変更は認めない。Unix socketだけにする代案もあるが、標準 `ssh -W` で直接扱えず追加の転送構成が必要なため本案では採らない。

VM起動後にnode所有0700のruntime領域を作り、helperのflockで初回起動だけを直列化する。snapshotにPID、Xauthority、Chromium profile、接続用の秘密を焼かない。起動済み判定はPIDだけでなく所有者・開始時刻・generationとVNC応答を照合する。固定ポートが他プロセスに使われていたら置き換えずエラーにする。

画面のsupervisorはSSH接続から切り離し、stdioを閉じて自身のログへ向ける。CLI終了・ブラウザ切断でXfceを止めない。最初の起動に失敗した場合は、その起動が作ったプロセスだけを回収する。既存プロセスの推測終了やデスクトップの無条件再作成はしない。VM停止で画面も失われる。healthのNodeプロセスは独立して維持し、子プロセス回収のためのinit導入が必要かDockerで確認する。

同じVMへの複数CLIは別々のlocalhostポート・秘密・SSH子を持つ。同じTigerVNC画面を共有し、二つ目が一つ目を切断しないようAlwaysSharedを明示する。初版は一定の画面サイズを手元で縮尺表示し、複数viewerのリサイズ要求で画面サイズが競合しないようにする。TigerVNCはloopback限定と共有接続の設定を提供する。[TigerVNC Xvnc](https://tigervnc.org/doc/Xvnc.html)

## ブラウザとlocalhostの境界

HTTPは `127.0.0.1` のport 0へbindし、割当済みの単一originを正解とする。`localhost`や任意Hostを同一扱いせず、全HTTP要求のHostをその `127.0.0.1:<port>` と照合する。DNS rebindingで外部の名前がloopbackへ解決してもHostで拒否する。

CLI起動ごとに暗号学的乱数32 bytesの能力トークンを作り、ブラウザ起動URLのfragmentで渡す。fragmentを読んだwrapperはhistory.replaceStateで除去し、JavaScriptメモリだけに保持する。AWS tokenとは別物で、DB、ファイル、access log、例外へ出さない。リロードで失う場合は再度CLIから開く。ページ内の再接続はメモリ内トークンを使える。

WS upgradeは正確なHost、正確なOrigin、期待するパス、能力トークンの全てを満たす場合だけ許可する。Originなし・null・外部originを拒否する。noVNCの `wsProtocols` で能力トークンを送ればquery stringへ載せずに済む。Cookieを認証に使わず、外部サイトからのHTTPリクエストだけではSSH起動・画面接続が起きない。能力トークン不一致時にSSH子を作らない。ブラウザの任意Host/portを転送先として受け付けない。

HTTPは既知のHTML/JS/CSSだけを返し、ファイルシステムの任意パス、コマンド実行API、shutdown APIを設けない。CORS許可なし、CSPでscript/connect先を当該originへ限定、frame-ancestors none、Referrer-Policy no-referrer、nosniff、機密応答no-storeとする。ローカル別ユーザーはHTTP資材を取得できても能力トークンなしで接続できない。同じOSユーザーを追加の隔離境界とは扱わない。

WS binaryとSSH stdoutを双方向へ転送し、stderrは診断へ分離する。上限付きbufferとbackpressure、接続数上限、準備timeoutを持つ。切断時はそのSSH子だけを終了し、残る場合は期限後killする。CLIのSIGINT/SIGTERMでは全WS・HTTP listener・自分のSSH子を回収する。SIGKILLで親が消えてもpipe閉鎖でSSHが終わることを検証する。

## 配布物とChromiumの制約

noVNCの固定版依存と自作の小さなbrowser wrapperから、Bunのbrowser buildでJS bundleを作る。生成資材を明示した少数の通常ファイルとしてリポジトリへ置き、生成コマンドと生成差分検査を付ける。CLIはその実在資材を `with { type: "file" }` で読む。開発時 `bun run cli` と `bun build --compile` の両方で同じ資材を使い、未生成ファイルのimportがtypecheckを壊す構成、実行時CDN、実行時node_modules探索を避ける。別ディレクトリへ単体実行ファイルだけコピーして確認する。[Bunの埋込み資材](https://bun.sh/docs/bundler/executables)

noVNCのcoreと同梱依存のライセンス表示を保ち、通知文も埋込み資材として単体CLIから参照可能にする。生成bundleを手編集しない。CLIの配布サイズと資材の再生成手順が増えることは本案の明確な不利益。[noVNCライセンス](https://github.com/novnc/noVNC/blob/master/LICENSE.txt)

Debian BookwormのChromiumにはarm64 packageがある。Google Chromeのamd64専用配布を前提にせず、imageのarchitectureに合うDebian packageを使う。Xfce・font・D-Busを最小構成で追加し、画面起動前の通常SSH利用ではGUIプロセスを動かさない。[Debian Chromium](https://packages.debian.org/bookworm/chromium)

Chromiumはnodeユーザーで起動し、user namespace等のsandboxが実VMで使えるかを最初に確認する。既知のNoNewPrivs=1ではsetuid helperへの依存が問題になり得る。MicroVM隔離とChromium内のrenderer隔離は同じものではないため、失敗を隠して `--no-sandbox` へ自動fallbackしない。利用可能なsandbox、`/dev/shm`、GPUなしの描画、メモリ量をDockerと実AWSで別々に測る。sandboxが成立しない場合は制約を実測として設計担当へ戻す。[Chromium Linux sandbox](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/linux/README.md)

## 判断と受入確認

主な利点は、VMにHTTP/WebSocketサーバーとnoVNC資材を持たせず、ブラウザアクセスの保護を既存Bun CLIに集約できること。noVNC更新だけならVM imageを再作成せずに済み、既存AWS認証とhost pinを再利用できる。VM側にnoVNCと変換処理も置く構造と比べ、単体CLIの資材管理とローカルWS中継の実装・保守が増える。ブラウザ表示中はCLIが必要で、ブラウザだけで後日再接続する仕組みにはしない。

検証はD1–D5に対応させる。HTTP/WSでは悪いHost・Originなし/null/外部Origin・不正能力トークン・任意パス・文字frame・過大frameを拒否し、認証拒否でSSHが起動しないことを確認する。遅いviewerでbufferが増え続けないこと、切断とSIGINT/SIGKILLでローカル子が残らないことも確認する。

Dockerで同時ensureの画面1個、2viewer共有、画面切断後のChromium状態保持、起動失敗の自己cleanup、他プロセスのポート衝突、health/SSH回帰を確認する。実AWSではVM内の開発サーバーをChromiumで表示し、noVNC画面を実際に見て入力欄へ文字を打ち、クリックによるDOM変化を確認する。スクリーンショットだけで入力成功としない。再接続、VM終了中の切断、単体CLIからの起動を確認して検証VMを終了する。

現時点は資料と既存経路に基づく設計。親から、DockerのGUI試作成功、通常Docker seccomp下のChromium失敗、試作でseccomp=unconfinedなら成功との報告を受けた。また実AWS image4.0のnodeで `unshare -Ur true` が成功し、検証VMは終了済み（`../evidence/namespace-probe.json`）。これはChromium本体のsandbox成功を証明しない。残る重要な未知は新imageでのChromium起動とARM64 VMのGUI負荷、転送帯域。比較と採否、確定後のOKF保存は親担当へ渡す。
