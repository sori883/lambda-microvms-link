---
status: stable
governance: context
tags: 
  - MicroVM
  - CLI
  - desktop
  - SSH
  - noVNC
code_refs: 
  - src/desktop.ts
  - src/desktop-client/**
  - src/desktop-assets/**
  - src/cli.ts
  - image/desktop.mjs
  - image/mvm-desktop
  - image/Dockerfile
  - scripts/build-desktop.ts
  - tests/desktop.test.ts
  - tests/image-desktop.test.ts
  - infra/microvm-foundation-stack.ts
sources: 
  - resource: .space/tasks/desktop/task.md
  - resource: .space/tasks/desktop/design.md
  - resource: .space/tasks/desktop/review.md
  - resource: src/desktop.ts
  - resource: image/desktop.mjs
  - resource: https://tigervnc.org/doc/Xvnc.html
  - resource: https://raw.githubusercontent.com/novnc/noVNC/master/docs/API.md
  - resource: https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux
type: decision
title: CLIから既存SSH経由でVMのデスクトップを開く
description: CLIからnoVNCとprivate VNC socketを既存SSHで接続する設計、GUIの寿命、認証・sandbox・起動期限の境界と実AWS検証を記録する。
generated: 
  by: agent:codex
  at: 2026-10-20T08:06:05.538Z
---
# CLIからSSH経由でVMのデスクトップを開く

2026年10月20日、ユーザーが最初の引き継ぎにあったデスクトップとブラウザを次の機能として依頼した。CLI中心の利用を保ち、`mvm session desktop NAME [--no-open] [--port N]` を追加した。手元のブラウザにnoVNCを表示し、VMのXfceとChromiumを操作する。Web管理画面やチャットUIは追加しない。

## 構成と選択理由

手元のブラウザ → 127.0.0.1のBun HTTP/WebSocket → 既存のOpenSSH → AWS managed shell WebSocket → 固定のmvm-desktop connectコマンド → private VNC Unix socket → Xfce/Chromiumという経路を使う。名前付きセッションのAWSアカウント照合・保存SSH設定・ホスト鍵固定を再利用する。

独立した二案と比較担当で検討し、ローカル配信案へUnix socketとGUI世代確認を組み込んだ。VM側HTTP gatewayとPython/websockify、独自閲覧leaseは不要になる。TCPの無認証loopback VNCは同一VM内の接続境界が弱くなるため採らない。新たなAWS公開ポート、実行ロール、AdditionalOsCapabilitiesは追加しない。

## 起動契約と寿命

`mvm-desktop ensure` はnodeユーザーでGUIを起動または再利用し、`{protocol:1,generation:UUID,width:1280,height:800}` 一行を返す。排他制御とsupervisorが同時初回起動をまとめる。connectは世代を検証し、任意path/portは受け取らない。GUIとChromiumは画面接続から独立して生存し、ブラウザを閉じた後のensureは同じGUIでChromiumを再起動する。

CLIは前景で接続を提供する。Ctrl+Cはローカルlistenerと所有するSSH子を回収するが、VMは終了しない。再実行で同じGUIへ戻れる。VMの存続期限やsession stopでGUIとブラウザ状態は失われる。プロジェクトの指定だけでは転送せず、開発サーバーの起動もSSH/VS Codeで別途行う。初版は固定1280×800、クライアントで拡大縮小、最大4接続。

## 境界と失敗処理

ローカルHTTP Host、WebSocketのHost/Origin/pathと256bit capabilityを完全一致で検証し、認証後だけSSH子を作る。capabilityはURL fragmentからJSメモリへ取り込みfragmentを除去し、WebSocket subprotocolへ渡す。AWS資格情報・トークンとSSH秘密鍵をブラウザへ渡さない。通常出力へ秘密URLを出さず、明示した--no-openで手動接続用に表示する。

OSのブラウザ起動はURLをプロセス引数へ渡す。別Web originの要求を拒否するが、同じ端末のプロセス引数やブラウザ状態を読める利用者からURLを隠す保証はない。信頼できる手元の利用者環境で使う。

VMのruntimeは0700、VNC/control socketは0600。VNC/X11のTCP待受を無効にし、Chromiumのsandboxを有効に保つ。Xfceによる自動ssh-agent起動は専用XDG設定で無効にし、GUI失敗時に所有するプロセス群を回収する。rootのmanaged shell権限を持つIAM主体に対する追加の隔離ではない。

ローカルは1 MiBフレームと4 MiBバッファに制限し、送信停止時は中継を終了する。Bun1.4.2でNode互換wsのmaxPayloadとchild_processのwritableLengthが期待通りの制御にならないケースを実テストで確認したため、Bun.serve/Bun.spawnと明示的な入力キューを使う。noVNC1.7.0の固定資材とライセンスをCLIへ同梱し、build:desktopとverify:desktop-assetsで再生成を管理する。

起動はsupervisor全体で90秒の共通deadlineを持つ。Xauth・Xvncの準備確認・D-Bus・Xfce設定・Chromiumとそのウィンドウ確認も残余予算を使い、readyでwatchdogを解除する。ensureの待機は95秒で回収・診断の猶予を含む。ロック取得待ち100秒とCLI全体120秒は別枠なので極端な競合ではCLIが先に終了し得る。後日のChromium再起動は新しい90秒で扱い、既存Xfceを終了しない。Chromiumがexit/errorになればpending probeを中断し、ready確定直前にも生存確認する。補助コマンドも所有するprocess groupとして回収する。

失敗時のprivate failure.jsonにはstage、reason、elapsedMs、exit code/signalを記録する。診断保存が失敗しても子回収を続ける。CLIはstderrを最大末尾4 KiB保持し、既知のDesktopStartFailed:<stage>またはDesktopStartTimeoutの完全一致だけを表示し、任意のプロセスログを流さない。

image5.0の新VMはChromiumの15秒待ちで初回失敗し、同じVMの後続ensureは成功した。初回読み込み遅延を疑うが内部原因までは断定しない。Chromiumの待ちを60秒、ensureを90秒、ロック取得待ちを100秒にした。CLIの120秒はAWS/SSH準備からlistener完成までを含む。ロック待ちとensureは別枠なので極端な競合ではCLIが先に期限を迎える。GUI準備後のブリッジ30秒は初回起動を打ち切らない。 このimage6.0時点の修正は後述のユーザー実行で不十分と判明し、共通deadline方式へ置き換えた。

## 実証と限界

macOS ARM64/Bun1.4.2で資材一致・型検査・55テスト成功、任意Docker4件は通常実行でスキップ。今回のGUI Docker3件は別実行で成功し、同時ensure、RFB、ブラウザ再起動、sandbox、起動失敗時の子回収、16秒遅延の旧版失敗/新版成功を確認した。Docker検証コンテナのみseccomp=unconfinedを使うが、AWSや製品のsandboxを緩めていない。

開発用アカウント242201303782、ap-northeast-1にcdkd full-waitでimage6.0を反映した。リポジトリ外の単体CLIから新VMへ最初のdesktopを実行し、37.824秒で成功した。実noVNC画面でVM内localhost:3000を開き、クリックとキー入力をサーバー応答で確認した。Chromium rendererのUID1000、NoNewPrivs=1、Seccomp=2と専用uid_mapを確認した。image5.0では再接続後の画面状態保持、SIGINT/SIGKILLでのCLI/SSH子回収も確認済み。image6.0ではVM終了時のDisconnectedを確認し、全検証VMと接続を終了した。

Windows、Linux手元でのブラウザ自動起動、日本語IME・クリップボード・音声は実機未確認。これらを検証済み対応として案内しない。検証の詳細・画像・終了記録は `.space/tasks/desktop/task.md` とevidence/に置く。エージェントの実装・検証であり、人間による内容確認を意味しない。

## image6.0初回Xvnc失敗と共通deadlineへの修正

2026年10月20日、ユーザーがimage6.0のdesktop-demoでDesktopStartupFailedを報告した。failure.jsonはxvncを示し、別の新VMでも再現した。計測ではXvncが生存しUnix socket/screen0の開始を記録していたが、xdpyinfo確認が完了する前に15.214秒で打ち切った。ユーザーVMは同じコードのensure再実行が51.321秒で成功した。内部I/O遅延の原因は断定しない。以前の単一VMでの成功とChromiumだけの待機延長では、起動経路全体の遅延を扱えていなかった。

Xvnc16秒遅延の旧版失敗を確認し、上記共通deadlineへ変更した。Xvnc16秒・xdpyinfo3秒・設定4秒遅延の組合せが成功した。独立レビューで見つかったpending probe中のChromium終了についても、1秒後exit42/30秒probeで旧候補失敗を再現し、修正版では約2.2秒で実際の終了理由を返した。通常テスト56件、GUI Docker5件が成功した。

cdkdでimage7.0へ更新し、二つの新しいVMが最初のsession desktopでそれぞれ38.916秒・35.711秒で成功した。今回の観測は任意の負荷でも90秒以内に起動する保証ではなく、正常な準備を個別の短い期限で中断する不具合の修正を示す。新たな失敗時は段階と終了理由を使って確認する。証拠は.space/tasks/desktop/evidence/startup-fix/、レビューは.space/tasks/desktop/review.md。ユーザーのdesktop-demoは復旧した状態で維持し、検証用VMだけを終了する。

# Related Concepts
- [名前付きセッションを端末のSQLiteで管理する](named-sessions.md): 名前・AWS対象・SSH設定・VMの寿命を再利用するデスクトップ接続。

- [AWSのWebSocket経由で接続ごとのOpenSSHを使う](ssh-over-websocket.md): GUIの画面と入力を既存のAWS認証・ホスト鍵固定を持つSSH経路へ載せる。
- [MicroVMイメージを単一のCDKスタックで構成する](microvm-foundation.md): 既存の資材とビルド権限を更新してGUI対応image6.0を作成した基盤。
- [MicroVM開発環境の目的と範囲](../knowledge/microvm-development-environment-scope.md): 2026年10月20日の追加依頼でCLIから開くデスクトップを対象へ含めた。