<!-- koto:setup:koto:codex:start -->
# koto

- 開発依頼では `.agents/skills/devlow/SKILL.md` を読み、依頼の種類・規模・リスクに応じて工程と成果物を選ぶ。
- 共通のルール・原則とプロジェクト固有の知識は、同じ `.space/babel` に保存する。`.agents/skills/use-principles/SKILL.md` の手順で検索し、利用者の指示と既存のプロジェクト規則に従う。
- プロジェクト固有の設計・判断・歴史は `.space/babel/` の対応するtype別ディレクトリへ保存し、既存の同名文書を確認してから作成・更新する。
- 対象コードを調査・変更するときは、`.agents/skills/okf-agent-memory/SKILL.md` のパス検索で `code_refs`に対応する理由・制約も読む。コメント整理は `.agents/skills/no-comments/SKILL.md` に従い、必要な知識を保存・照合してから削除する。
<!-- koto:setup:koto:codex:end -->

# 実行環境

- パッケージ管理と手元の実行環境はBunを標準とする。CDK、cdkd、型検査、テストは `mise exec -- bun run <script>` で実行する。`bunfig.toml` の `run.bun` で、Node.js指定のCLIもBunから起動する。
- kotoのCLIにはBun 1.4.2以上が必要。`mise.toml`の設定を使い、`mise exec -- bun <CLIのパス> ...`で実行する。
