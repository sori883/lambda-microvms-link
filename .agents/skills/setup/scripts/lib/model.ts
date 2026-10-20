export type Mode = "copy" | "managed-block" | "merge-index" | "seed";
export const instructionFiles = { codex: "AGENTS.md", "claude-code": "CLAUDE.md", copilot: ".github/copilot-instructions.md" } as const;
export type Product = keyof typeof instructionFiles;
export type Scope = "plugin" | "project";
export const projectSkillRoots = { codex: ".agents/skills", "claude-code": ".claude/skills" } as const;
export function projectSkillRoot(product: Product): string | undefined { return product === "copilot" ? undefined : projectSkillRoots[product]; }
export function setupPlugins(plugin: string): string[] { return plugin === "koto" ? ["koto", "agent-gear"] : [plugin]; }
export function isProduct(value: unknown): value is Product { return typeof value === "string" && Object.hasOwn(instructionFiles, value); }
export interface Entry { source: string; destination: string; mode: Mode }
export interface Manifest { schemaVersion: 1; plugin: string; product: Product; version: string; scope?: "project"; files: Entry[] }
export interface Installed extends Entry { hash: string; indexSource?: string }
export interface State { schemaVersion: 1; plugin: string; product: Product; version: string; scope?: "project"; entries: Installed[] }
export interface Operation { destination: string; beforeHash: string | null; content: string }
export interface Pending { schemaVersion: 1; manifestHash: string; beforeStateHash: string | null; nextState: State; operations: Operation[] }
export interface Action { destination: string; mode: Mode; action: "create" | "update" | "unchanged" | "retain"; reason: string }
export interface Conflict { destination: string; reason: string }
export interface Result { plugin: string; product: Product; version: string; scope: Scope; project: string; actions: Action[]; conflicts: Conflict[]; pending: boolean; locked: boolean }
export class SetupError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
