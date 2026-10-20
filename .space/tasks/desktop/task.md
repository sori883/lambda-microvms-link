# MicroVMデスクトップとブラウザ

2026年10月20日。ユーザーは次の機能としてデスクトップとブラウザの利用を依頼した。最初の引き継ぎにはnoVNCによるXfceデスクトップ、ChromiumでVM内localhost:3000を表示する体験がある。画像そのものとlllの内部実装は未確認で、引き継ぎの説明を利用体験の根拠とする。

## 範囲と完了条件

- D1: CLIから名前付きセッションのデスクトップを開き、手元のブラウザで画面と入力を扱える。
- D2: VM内のChromiumで同じVMの開発サーバーを開ける。画面を実際に確認し、キーボード/マウス操作の結果を検証する。
- D3: 既存のSSH・VS Code・セッション管理とhealthを維持する。画面切断でVMを終了しない。再接続で同じデスクトップを扱える。
- D4: 画面サービスを無認証で外部公開しない。AWS認証と既存のホスト鍵検証を維持し、接続秘密をイメージやログへ固定しない。
- D5: 起動失敗、同時接続、切断、CLI中断、VM終了を扱う。自身の検証VMとローカル接続は片付ける。

Webの管理画面やチャットUI、自動同期、Suspend/Resume、公開配布は今回の範囲外。CLI中心の方針を維持し、画面表示にブラウザを用いる。

## 工程

中規模。新しいGUIサービスとローカル接続境界があるため、独立候補A/B、独立比較、実装、Dockerと実AWSでの経路検証、独立レビューを行う。前回のセッション管理とSSHを再利用する。既存の大量の未追跡ファイル・README変更は保持する。コミットと公開は依頼されていない。

ルール0件、原則23件のdescriptionを確認。experience-first、exhaust-the-design-space、boundary-discipline、make-operations-idempotent、prove-it-works、separate-before-serializing-shared-state、test-behavior-not-implementationの本文を適用。image/Dockerfileとsrc/session-ssh.tsのパス検索で既存のCLI・SSH・基盤・名前付きセッションの判断を再利用する。

## 開始時の状態

イメージ4.0はDebian Bookworm、Node.js24、OpenSSH、rsync、Git、curl。GUIなし。既存SSHはAWS managed shellのWebSocket経由でsshd -iへ接続し、TCP転送はsshd既定で有効。デスクトップ用の新しい公開ポートをAWS側に追加する必要性は設計で比較する。Docker28.4.0が利用可能。

## 完了した実装

独立候補A/Bと独立比較を経て、[採用設計](design.md)を実装した。VM GUIはcli_design_a、ローカル接続はcli_design_b、CLI・infra統合と実AWS/UI検証はrootが担当し、cli_compareが実装を独立レビューした。[レビュー記録](review.md)を参照。

`mvm session desktop NAME` は名前付きセッションへSSH接続し、Xfce・Chromiumを起動または再利用する。noVNCの画面資材は単体CLIへ同梱し、手元のブラウザから127.0.0.1のCLI、既存SSH、AWS shell WebSocket、VMのprivate VNC Unix socketへつなぐ。初版は1280×800、最大4接続。`--no-open` と固定ポート指定を扱う。Ctrl+Cは画面接続だけを終え、VMとGUIは残る。

画面接続のHost・Origin・パス・256bit capabilityを検証してからSSH子プロセスを作る。VMのVNC/X11はTCPで待ち受けず、Chromiumのsandboxは有効。追加のAWS公開ポート、実行ロール、OS capabilityはない。ローカルのプロセス引数やブラウザ状態を読める利用者から、ブラウザ起動URLの秘密を隠す保証は置かない。

## 検証結果

| 条件 | 結果・証拠 |
| --- | --- |
| D1 CLIから表示・操作 | リポジトリ外へ置いた単体CLIでimage6.0の新VMへ初回接続。GUIを事前起動せず37.824秒で準備完了し、実画面でConnectedとXfce/Chromiumを確認。[初回接続](evidence/aws-fresh-desktop.json)、[画面](evidence/desktop-final.png) |
| D2 VM内の開発ページ | SSHで独立した検証用Nodeサーバーを/workspaceへ送り127.0.0.1:3000で起動。Chromiumで開き、実際のクリックとキー入力で `{"clicks":1,"message":"desktop-ok"}` を保存。[サーバーから読んだ結果](evidence/aws-fresh-ui-state.json) |
| D3 既存経路・再接続 | 通常の回帰テスト55件、image6.0のSSHとhealth成功。image5.0でReconnectボタン、CLIをCtrl+Cで閉じて別ポートから再接続し、ページ・入力・クリック数と同じGUI世代を保持。[再接続画面](evidence/desktop-reconnected.png)、[世代](evidence/aws-desktop-reused.json)、[health](evidence/aws-fresh-health.json)。VS Code Server初回導入の実AWS検証は既存image4.0の記録で、6.0で再導入は行っていない |
| D4 接続境界 | unitで不正Host/Origin/パス/tokenをSSH開始前に拒否。実AWSでruntime0700、socket0600、GUI TCP待受なし。Chromium rendererのUID1000・NoNewPrivs=1・Seccomp=2と専用uid_mapを確認。`--no-sandbox`なし。[実VMの状態](evidence/aws-fresh-runtime.json) |
| D5 故障・終了 | Dockerでsandbox起動失敗、子回収、無関係プロセスの維持、同時ensure、ブラウザ再起動、遅い初回起動を確認。CLIは中断・過大入力・読取停止・同時接続上限を検証。実AWSではCtrl+CとSIGKILLでローカル子/ポートを回収、VM終了時のDisconnectedを画面確認。[中断](evidence/interrupt.json)、[強制終了](evidence/forced-exit.json)、[VM終了画面](evidence/desktop-vm-ended.png)、[最後の片付け](evidence/aws-fresh-cleanup.json) |

`mise exec -- bun run verify` は資材の再生成一致、型検査、55 pass / 4 skip / 0 fail（25.18秒）。4 skipは明示有効化するDockerテストで、今回追加のGUI3件は別途実行し3 pass / 0 fail（20.67秒）。残るSSH Dockerテスト1件はこの全体実行ではスキップした。[全体](evidence/verify-final.log)、[GUI Docker](evidence/docker-tests.log)、[単体ビルド](evidence/cli-build.log)。

Docker標準seccompではuser namespaceが拒否されるため、GUI検証コンテナのみseccomp=unconfinedを使用した。製品のAWS側は保護設定を緩めていない。image4.0での事前namespace probeも終了済み（[記録](evidence/namespace-probe.json)）。検証環境はmacOS ARM64/Bun1.4.2とAWS ARM64。Linux手元でのブラウザ自動起動、Windows、日本語IME、クリップボード、音声は実機未検証であり、今回の確認結果に含めない。

## 実機で見つかった起動待ちの修正

image5.0の最初のGUI起動は `DesktopStartFailed:chromium` となった。同じVMの後続起動は約3秒で成功し、初回の読み込み遅延を疑ったが、遅延の内部原因までは断定していない。Chromiumのウィンドウ待ちを15秒から60秒、ensure全体を90秒、ロック待ちを100秒へ変更した。CLIの準備期限は従来の120秒で、ロック待ちとensureは別枠のため極端な競合ではCLIが先に終了する。

16秒遅延のDockerテストは旧版で失敗、修正版で成功することを確認した。image6.0の新VMでは、同じ失敗を温まったVMで再試行して済ませず、最初の `session desktop` で37.824秒の成功を得た。通常接続時の30秒ブリッジ期限はGUI準備後に始まる。

初期ローカル案のNode互換HTTP/WSでは、Bun1.4.2でmaxPayloadとstdin.writableLengthに期待した制御が効かないケースがテストで分かった。ローカル中継をBun.serve/Bun.spawnに切り替え、1 MiBフレーム・4 MiBバッファの制限を実転送テストで確認した。

## AWS変更と片付け

profile AdministratorAccess-242201303782、account 242201303782、region ap-northeast-1、stack MicrovmFoundation。GUIを加えたimage5.0と起動待ちを修正したimage6.0をcdkd full-waitで作成した。各更新は0 create / 2 update / 0 delete。最終実行SUCCEEDED、LatestActiveImageVersion=6.0、最終diffは変更なし。ビルド権限は新ZIP一個への参照に更新し、リソースは従来の3つ。

- [最終デプロイ](evidence/cdkd-cold-start-deploy.log)、[状態](evidence/cdkd-state-final.json)、[履歴](evidence/cdkd-events-final.log)、[最終diff](evidence/cdkd-final-diff.log)
- image5.0のdesktop-check / microvm-33212608-88dd-31a1-af92-03a4057cfb3aは[TERMINATED](evidence/aws-stop.json)。
- image6.0のdesktop-fresh / microvm-0bab5bca-ea6e-3225-81bc-73ec1683c99dも[TERMINATED](evidence/aws-fresh-stop.json)。
- 検証用の独立stateディレクトリにSSH秘密鍵が残っていないこと、CLI/SSH子と待受ポートが終了したことを確認。利用者の既存セッションやSSH設定を変更していない。イメージと基盤は次の利用用に保持。

READMEに利用方法・制限・検証方法を記載した。設計判断はOKFのdecisions/desktop-over-sshへ保存し、範囲と基盤の既存文書も更新済み。保存後のshowで本文、generated、code_refs、関連付けを照合した。strict/drift検証はerrors・warnings・broken_links・gate_findingsが0、is_conformant=true。以前からある共通原則17件の孤立は残っており、gate_passed=false / exit1である。今回の文書は孤立していない。無関係な原則を機械的に結び付けてゲートを通すことはしていない。[検証結果](evidence/okf-validate.json)を参照。

実装・ビルドに対応するファイルのSHA-256は[source-sha256.json](evidence/source-sha256.json)へ記録した。コード変更後の追加テストは必要な範囲を完了し、その後は利用説明と記録だけを更新した。コミット・公開は行っていない。

## 2026年10月20日・ユーザー環境での初回起動失敗への対応

ユーザーがimage6.0で作成したdesktop-demo（microvm-3283e119-37d9-3bf1-9971-ebbacb47d3ee）でDesktopStartupFailedを報告した。VMのfailure.jsonは `DesktopStartFailed:xvnc` だった。前回の「Chromiumだけ60秒待てばよい」という修正は、Xvnc15秒・probe2秒・設定3秒の短い期限を残していた。image6.0で成功した既存証拠は保持するが、初回起動の安定性を示すものとしては不足していた。

ユーザーVMでは既存コードのensure再実行が51.321秒で成功し、GUIを復旧した。終了や作り直し、ファイル削除はしていない。別の検証専用image6.0 VMへ計測版を置くと同じXvnc失敗を再現した。Xvncはプロセス終了しておらず、Unix socketとscreen0の起動を記録していたが、xdpyinfo準備確認が終わる前に15.214秒で打ち切られていた。内部I/Oの遅延原因は断定しない。[失敗](evidence/startup-fix/user-failure.txt)、[復旧](evidence/startup-fix/user-retry.json)、[別VMの計測](evidence/startup-fix/probe-trace.jsonl)。

既存のオンデマンドGUI構成を再利用し、起動全体の90秒deadlineへ統一した。Xauth・設定変更・probeも残余予算で待ち、GUI ready時にwatchdogを解除する。起動待ちのensureには診断と回収の5秒猶予を加えた。後でChromiumだけ閉じて再起動する場合は、新しい90秒の予算を使い既存GUIを維持する。固定のprocess groupへ補助コマンドも登録して失敗時に回収する。private failure.jsonには段階・理由・経過時間・終了コード/シグナルを記録する。

CLIはSSH stderrを最大末尾4 KiBだけ保持し、既知のDesktopStartFailed:<段階>等の完全一致だけを表示する。任意ログや秘密は表示しない。TDDでXvnc16秒遅延の旧版失敗、修正版のXvnc16秒・xdpyinfo3秒・設定4秒の成功を確認。安全な失敗段階の表示も旧版失敗→修正版成功を確認した。`verify` は56 pass / 6 skip / 0 fail、GUI Dockerは別途5/5成功。[red](evidence/startup-fix/docker-red.log)、[green](evidence/startup-fix/docker-green.log)、[CLI red](evidence/startup-fix/cli-red.log)、[全体](evidence/startup-fix/verify.log)。

cli_design_aが共通deadline案を独立検討し、probeの短い期限もなくすこと、ready後とブラウザ再起動の期限を分離すること、診断取得の猶予と子回収を条件に支持した。ready hookでのprewarmはSSH利用にもGUI起動を課すため今回は採らない。実装レビューでpending probe中のChromium終了の検知漏れを指摘し、exit/errorからprobeを中断する修正とready直前の生存確認を追加した。1秒後exit42と30秒probeの回帰テストは、修正前失敗、修正後2.215秒で終了情報を保持して成功。再レビューで必須指摘は解消済み（[記録](review.md)）。

同じAWS対象にcdkdでimage7.0をデプロイし、full-waitが194.95秒で成功した。差分は0 create / 2 update / 0 delete、LatestActiveImageVersion=7.0、最終diffは変更なし。CLIも再ビルドし、リポジトリ外へコピーしたバイナリとdist/mvmの一致を確認した。[デプロイ](evidence/startup-fix/cdkd-deploy.log)、[状態](evidence/startup-fix/cdkd-state.json)、[最終diff](evidence/startup-fix/cdkd-final-diff.log)、[ソースとバイナリのSHA-256](evidence/startup-fix/source-sha256.json)。

GUIを事前起動していないimage7.0の新VM2台で、最初のsession desktopが38.916秒・35.711秒で成功した。startup-fresh-aは手元のnoVNC画面でConnectedとXfce・Chromiumの表示も確認した。startup-fresh-bはCLIの初回準備完了までの確認である。[初回接続2件](evidence/startup-fix/fresh-starts.json)、[画面](evidence/startup-fix/image7-desktop.png)。任意の負荷で90秒以内に必ず起動する保証としては扱わない。

今回作成した検証用VM3台はTERMINATEDを確認した（[再現用](evidence/startup-fix/probe-stop.json)、[新VM A](evidence/startup-fix/startup-fresh-a-stop.json)、[新VM B](evidence/startup-fix/startup-fresh-b-stop.json)）。検証用CLIと待受ポートを終了し、独立state内のSSH秘密鍵は0件だった（[片付け](evidence/startup-fix/cleanup.json)）。ユーザーのdesktop-demoはimage6.0のまま復旧しており、08:06 UTC時点でRUNNING、期限08:44:44 UTCだった（[状態](evidence/startup-fix/user-final-status.json)）。ユーザーVMの終了・作り直しは行っていない。

READMEとOKFのdesktop-over-ssh・microvm-foundationを更新し、保存内容を再取得して照合した。strict/drift検証はerrors・warnings・broken_links・gate_findingsが0、is_conformant=true。以前からある共通原則17件の孤立によるgate_passed=false / exit1は継続している（[検証結果](evidence/startup-fix/okf-validate.json)）。今回の実装・検証・片付け・記録は完了。コミット・公開は行っていない。
