import { parseYaml, stringifyYaml } from "obsidian";

export const SNAPSHOT_MARKER_KEY = "fns-share-snapshot";
export const SNAPSHOT_RENDER_VERSION = 11;

export const THEME_CSS_FILENAME = "_fns-theme.css";
export const SNAPSHOT_HTML_LANG = "fns-rendered";
// 4-backtick fence so any ``` run inside the baked HTML can never close the block early.
export const SNAPSHOT_FENCE = "````";

export interface SnapshotMeta {
  source: string;
  sourceMtime: number;
  sourceSize: number;
  sourceHash: string;
  renderVersion: number;
  pluginVersion: string;
  generated: number;
}

export function buildSnapshotContent(meta: SnapshotMeta, payload: string): string {
  const frontmatter = stringifyYaml({
    [SNAPSHOT_MARKER_KEY]: 1,
    "fns-source": meta.source,
    "fns-source-mtime": meta.sourceMtime,
    "fns-source-size": meta.sourceSize,
    "fns-source-hash": meta.sourceHash,
    "fns-render-version": meta.renderVersion,
    "fns-plugin-version": meta.pluginVersion,
    "fns-generated": meta.generated,
  });
  const fmBlock = frontmatter.endsWith("\n") ? frontmatter : frontmatter + "\n";
  return `---\n${fmBlock}---\n\n${SNAPSHOT_FENCE}${SNAPSHOT_HTML_LANG}\n${payload}\n${SNAPSHOT_FENCE}\n`;
}

// v8: the note body is a full standalone HTML document (served directly by the server), so there
// is no fenced payload anymore.
export function buildDocumentContent(meta: SnapshotMeta, document: string): string {
  const frontmatter = stringifyYaml({
    [SNAPSHOT_MARKER_KEY]: 1,
    "fns-source": meta.source,
    "fns-source-mtime": meta.sourceMtime,
    "fns-source-size": meta.sourceSize,
    "fns-source-hash": meta.sourceHash,
    "fns-render-version": meta.renderVersion,
    "fns-plugin-version": meta.pluginVersion,
    "fns-generated": meta.generated,
  });
  const fmBlock = frontmatter.endsWith("\n") ? frontmatter : frontmatter + "\n";
  return `---\n${fmBlock}---\n\n${document}\n`;
}

export function isSnapshotFrontmatter(frontmatter: Record<string, unknown> | null | undefined): boolean {
  return !!frontmatter && !!frontmatter[SNAPSHOT_MARKER_KEY];
}

export function parseSnapshotMeta(frontmatter: Record<string, unknown> | null | undefined): SnapshotMeta | null {
  if (!frontmatter || !frontmatter[SNAPSHOT_MARKER_KEY]) return null;
  const source = frontmatter["fns-source"];
  if (typeof source !== "string" || source.length === 0) return null;
  const sourceHash = frontmatter["fns-source-hash"];
  const pluginVersion = frontmatter["fns-plugin-version"];
  const asNumber = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    source,
    sourceMtime: asNumber(frontmatter["fns-source-mtime"]),
    sourceSize: asNumber(frontmatter["fns-source-size"]),
    sourceHash: typeof sourceHash === "string" ? sourceHash : "",
    renderVersion: asNumber(frontmatter["fns-render-version"]),
    pluginVersion: typeof pluginVersion === "string" ? pluginVersion : "",
    generated: asNumber(frontmatter["fns-generated"]),
  };
}

export function parseFrontmatterBlock(data: string): Record<string, unknown> | undefined {
  const match = data.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYaml(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function extractRenderedContent(content: string): string | null {
  const open = `${SNAPSHOT_FENCE}${SNAPSHOT_HTML_LANG}`;
  const start = content.indexOf(open);
  if (start === -1) return null;
  const afterOpen = content.indexOf("\n", start);
  if (afterOpen === -1) return null;
  const end = content.indexOf(SNAPSHOT_FENCE, afterOpen + 1);
  if (end === -1) return null;
  return content.slice(afterOpen + 1, end).replace(/\r?\n$/, "");
}
