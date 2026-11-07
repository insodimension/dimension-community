const SPACES_META_KEY = "ai.insodimension/spaces";
const EXCEPT_SPACES_META_KEY = "ai.insodimension/exceptSpaces";
const GRANTS_EVERY_SPACE = "*";

export const SPACES_UNDER_TEST = ["code", "build", "chat", "traction", "video", "unreal", "clients"] as const;

export interface ListedTool {
  readonly name: string;
  readonly _meta?: { readonly [key: string]: unknown } | undefined;
}

type DeclaredSpaces = readonly string[] | undefined | null;

function declaredSpaces(tool: ListedTool, key: string): DeclaredSpaces {
  const meta = tool._meta;
  if (meta === undefined || !Object.hasOwn(meta, key)) return undefined;
  const declared = meta[key];
  if (!Array.isArray(declared)) return null;
  return declared.every(entry => typeof entry === "string" && entry !== "") ? declared : null;
}

export function offeredToSpace(tool: ListedTool, space: string): boolean {
  const audience = declaredSpaces(tool, SPACES_META_KEY);
  const exceptSpaces = declaredSpaces(tool, EXCEPT_SPACES_META_KEY);
  if (audience === null || exceptSpaces === null || exceptSpaces?.includes(GRANTS_EVERY_SPACE) === true) return false;
  if (exceptSpaces?.includes(space) === true) return false;
  return audience === undefined || audience.includes(GRANTS_EVERY_SPACE) || audience.includes(space);
}

function callableByModel(tool: ListedTool): boolean {
  const visibility = (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility;
  const declared = Array.isArray(visibility) ? visibility.filter(entry => entry === "model" || entry === "app") : [];
  return declared.length === 0 || declared.includes("model");
}

export function offeredToModelOf<T extends ListedTool>(tools: readonly T[], space: string): T[] {
  return tools.filter(tool => callableByModel(tool) && offeredToSpace(tool, space));
}

export function namesOfferedToModelOf(tools: readonly ListedTool[], space: string): string[] {
  return offeredToModelOf(tools, space).map(tool => tool.name).sort();
}
