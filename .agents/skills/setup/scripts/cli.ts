import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runSetup } from "./lib/setup.ts";
import { isProduct, SetupError } from "./lib/model.ts";

export async function main(args = process.argv.slice(2)): Promise<number> {
  let compact = args.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { project: { type: "string" }, product: { type: "string" }, scope: { type: "string" }, source: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    compact = values.json ?? false;
    if (values.help) { console.log("Usage: bun <setup-skill>/scripts/setup.ts <plan|apply|status> --project <directory> [--product <codex|claude-code|copilot>] [--scope <plugin|project>] [--source <distribution-root>] [--json]\nplan/status are read-only for the project. apply writes only declared files and managed instruction blocks.\nThe distribution root defaults to this script's location; setup-manifest.json must be present there. A project-installed setup skill needs --source pointing to a downloaded distribution.\n--scope project copies all skills and agents into the project for Codex or Claude Code. Pass it on plan, apply, and status. The default plugin scope places shared knowledge and instructions only.\nThe product defaults to the distribution manifest. In VS Code with GitHub Copilot, pass --product copilot on every command; the distribution must include setup-manifest.copilot.json."); return 0; }
    const command = positionals[0];
    if (positionals.length !== 1 || !["plan", "apply", "status"].includes(command ?? "")) throw new SetupError("INPUT", "Specify exactly one command: plan, apply, or status");
    if (!values.project?.trim()) throw new SetupError("INPUT", "--project is required");
    if (values.product !== undefined && !isProduct(values.product)) throw new SetupError("INPUT", "--product must be codex, claude-code, or copilot");
    if (values.scope !== undefined && values.scope !== "plugin" && values.scope !== "project") throw new SetupError("INPUT", "--scope must be plugin or project");
    if (values.source !== undefined && !values.source.trim()) throw new SetupError("INPUT", "--source must be a distribution directory");
    const data = await runSetup({ command: command as "plan" | "apply" | "status", project: resolve(values.project), pluginRoot: values.source ? resolve(values.source) : resolve(import.meta.dir, "../../.."), product: values.product, scope: values.scope });
    console.log(JSON.stringify({ ok: true, data }, null, compact ? undefined : 2)); return 0;
  } catch (error) {
    const code = error instanceof SetupError ? error.code : (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") ? "INPUT" : error instanceof SyntaxError ? "INVALID_DATA" : "IO";
    console.log(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(error instanceof SetupError && error.details ? { details: error.details } : {}) } }, null, compact ? undefined : 2));
    return ["LOCKED", "CONFLICT", "PARTIAL"].includes(code) ? 3 : ["IO"].includes(code) ? 1 : 2;
  }
}
