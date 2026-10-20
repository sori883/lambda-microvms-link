---
name: setup
description: Install or update koto in an explicitly selected project, including project-local skills for Codex and Claude Code, shared knowledge, agents, and instruction blocks. Use for initial setup, installation checks, or updates while preserving local instructions and edits.
---

# setup

利用先プロジェクトへ、同梱する共通知識・エージェント定義・指示を配置する。CodexとClaude Codeでは、全スキルを実ファイルで配置するプロジェクト導入も選べる。取得した配布物から直接導入でき、プラグインの登録は必須ではない。

1. 対象プロジェクト・利用製品・導入方式を特定し、同梱するCLIで`plan --project <対象>`を実行する。プロジェクトにスキル本体を配置する場合は、plan・apply・statusのすべてに`--scope project`を追加する。GitHub Copilot in VS Codeでは`--product copilot`を使い、プロジェクト導入は選ばない。利用先を推測して書き込まない。
2. 変更先と衝突を確認する。既存の指示ファイルでは、このプラグインの管理ブロック外を保持する。配置済みファイルのローカル編集は自動上書きしない。
3. 依頼が配置・更新を含み、衝突がなければ`apply`を実行する。調査だけの依頼では`plan`または`status`で報告する。
4. `status`で配置と管理記録を確認し、配置先・保持したローカル文書・残った衝突を報告する。

CLIは`bun <このスキル>/scripts/setup.ts`。Bun 1.4.2以上を使い、`--project`を毎回指定する。配布ルートは通常CLI自身の位置から決める。プロジェクトへコピー済みのsetupを使う場合は、対象製品の配布物を取得し、`--source <配布ルート>`を指定する。更新時も新しい配布物を明示し、利用先のコピーを配布元として扱わない。実行時の準備はスキルのscripts内で行い、利用先のpackage.jsonや依存を変更しない。

操作、保存先、衝突時と中断時の扱いは[導入と更新](references/setup.md)を参照する。文書の配置後に、必要な共通知識を読み込んで利用する。ファイルの配置だけで全内容がAIへ読み込まれたとは扱わない。
