# 採用設計と分担

候補A/Bを独立に作成し、親と候補作成に参加していないcli_compareが比較した。両者ともBを土台にし、VM側VNCをUnix socketへ限定する構成を採用する。ユーザー操作、認証境界、共有状態、既存SSH再利用、単体配布、検証可能性を基準にした。

BのローカルBunによるnoVNC配信とWebSocket中継を採用する。AのVNC Unix socket、世代付きreadiness、同時ensure排他を取り込む。AのVM側HTTP gateway、Python/websockify、閲覧lease管理は不要になる。Bの無認証loopback VNCとssh -Wは採用しない。

## 契約

`mvm session desktop NAME [--no-open] [--port N]` が名前付きセッションのSSHを準備し、GUIを起動・再利用してローカルブラウザを開く。CLIが接続を提供する間は前景で動く。Ctrl+Cはローカル接続だけを終了する。再実行で同じVMのGUIへ戻る。初版の画面サイズは1280x800で、クライアント側で縮尺を変える。

- VM: `/usr/local/bin/mvm-desktop ensure` は一行のJSON `{protocol:1,generation:"UUID",width:1280,height:800}` を返す。nodeユーザーで起動・再利用し、標準出力にログや秘密を混ぜない。
- VM: `mvm-desktop connect <generation>` は同じ世代のprivate VNC Unix socketへ標準入出力を中継する。任意のpathやportを受け取らない。TCPのVNC/X11を無効にする。
- VM: Xfce、D-Bus、Chromiumをnodeで実行し、Chromium sandboxを無効化しない。初期URLはabout:blank。デスクトップは画面接続より長く生存し、VM終了で終了する。
- CLI: `sessionDesktop(connection: PreparedSessionSsh, options: {open:boolean;port:number}, signal:AbortSignal, prepared:()=>void): Promise<number>` をsrc/desktop.tsで公開する。ensureとローカルlistenerの準備完了まではsetup期限を維持する。
- Browser: localhostは127.0.0.1のみ。HTTP Host、WSのHost/Origin/pathと接続単位256bit capabilityを完全一致で確認し、その後だけSSH子を作る。capabilityはURL fragmentからJSメモリへ取り込む。AWSトークン・SSH鍵を渡さない。`--no-open`のときだけ、手動接続用URLの表示を明示的に許す。
- Assets: noVNCの固定版とwrapperを生成資材へbundleし、通常の開発起動と単体CLIの両方から利用する。生成元、再生成コマンド、ライセンス通知を保持する。

ローカルの利用者環境を信頼境界とする。Host/Origin検証は別Webページからの要求を拒否するが、ブラウザ起動へ渡すURLは一時的にopen/xdg-openの引数へ入り、起動先の実装によってはブラウザの引数にも残る。プロセス引数やブラウザ状態を読めるローカル利用者からcapabilityを秘匿する保証は置かない。

## 担当と検証単位

| 単位 | 所有者 | ファイルと完了条件 |
| --- | --- | --- |
| VM GUI | cli_design_a | image/Dockerfile、image/mvm-desktop、image/desktop.mjs、必要なimage内設定、tests/image-desktop.test.ts。Dockerで同時ensure、再利用、private socket、sandbox有効Chromium、healthを確認 |
| ローカル接続 | cli_design_b | src/desktop.ts、src/desktop-client/**、生成資材、scripts/build-desktop.ts等、package.json、bun.lock、関連型宣言、tests/desktop.test.ts。認証拒否、転送、中断・子回収、資材同梱を確認 |
| 統合・実機 | root | src/cli.ts、infra/microvm-foundation-stack.ts、tests/foundation.test.ts、README、task/design/evidence。CLI統合、実AWS、画面操作、文書・OKFと終了処理 |
| 独立レビュー | cli_compare | 読み取り専用。上記3単位の境界と実経路の証拠を照合 |

全担当は既存の他者の変更を戻さず、所有外の修正は連絡する。親が全体の状態をtask.mdへ記録する。現在のブランチには以前の未追跡成果物があるため、Git差分だけで変更を判定しない。

共通Docker probeはlambda-microvms-link:desktop-probe。通常DockerのseccompでChromium namespaceが拒否されるため、GUI検証コンテナに限ってseccomp=unconfinedを使用する。製品やAWSの保護設定を緩めるものではない。AWS image4.0では追加capabilityなしでnodeのuser namespace作成に成功した。Chromium本体のAWS確認は新イメージで行う。
