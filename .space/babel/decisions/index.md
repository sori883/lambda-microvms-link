# decisions
* [開発用CDKツールとしてcdkdを導入する](cdkd-development-tooling.md) - cdkdとCDKを固定版で利用し、Bunを標準実行環境とする方針、ローカル検証とAWS差分確認の結果、公式動作要件との境界を記録する。
* [MicroVMイメージを単一のCDKスタックで構成する](microvm-foundation.md) - イメージ資材と最小権限を単一CDKスタックにまとめる設計、CDKとAPIの差、および東京リージョンでのビルド・VM起動・認証付き応答の確認結果を記録する。
* [Bun CLIを明示IDの5操作から始める](bun-microvm-cli.md) - Bun製MicroVM CLIの責務、標準AWS認証、回復情報と出力の契約、実機検証と未確認範囲を記録する。
* [AWSのWebSocket経由で接続ごとのOpenSSHを使う](ssh-over-websocket.md) - Bun CLIのSSHと標準ファイル転送を、AWS managed shell、接続単位のsshdと一時鍵で提供する設計、信頼境界、寿命、実AWS検証を記録する。
* [名前付きセッションを端末のSQLiteで管理する](named-sessions.md) - 名前とVMの対応、起動結果不明時の復旧、AWS認証先の照合、永続SSHとVS Code設定の寿命、および実機検証を記録する。
* [CLIから既存SSH経由でVMのデスクトップを開く](desktop-over-ssh.md) - CLIからnoVNCとprivate VNC socketを既存SSHで接続する設計、GUIの寿命、認証・sandbox・起動期限の境界と実AWS検証を記録する。
