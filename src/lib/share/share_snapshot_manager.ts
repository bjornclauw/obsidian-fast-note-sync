import { normalizePath, TAbstractFile, TFile } from "obsidian";
import { gzipSync, strToU8 } from "fflate";

import type FastSync from "../../main";
import { dump, dumpError, hashContent, hashContentAsync } from "../utils/helpers";
import { NoteRenderResult, NoteRenderer } from "./note_renderer";
import {
  buildSnapshotContent,
  isSnapshotFrontmatter,
  parseFrontmatterBlock,
  parseSnapshotMeta,
  SNAPSHOT_RENDER_VERSION,
  SnapshotMeta,
} from "./snapshot_format";

export type SnapshotStaleStatus = "none" | "missing" | "changed" | "format";

export interface SnapshotStaleResult {
  status: SnapshotStaleStatus;
  snapshotPath: string | null;
}

export interface SnapshotBakeResult {
  snapshotPath: string;
  render: NoteRenderResult;
  meta: SnapshotMeta;
}

const DEFAULT_SNAPSHOT_FOLDER = "_fns-shares";

/**
 * Owns the rendered-share snapshots: a durable source->snapshot index (frontmatter is the source of
 * truth, this map is a cache), baking, staleness checks, rename handling and cleanup.
 */
export class ShareSnapshotManager {
  private readonly index = new Map<string, string>();
  private readonly renderer: NoteRenderer;
  private initialized = false;

  constructor(private plugin: FastSync) {
    this.renderer = new NoteRenderer(plugin);
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.registerVaultEvents();
    this.rebuildIndex();
  }

  public get snapshotFolder(): string {
    const raw = (this.plugin.settings.shareSnapshotFolder || DEFAULT_SNAPSHOT_FOLDER).trim();
    const cleaned = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return cleaned.length > 0 ? cleaned : DEFAULT_SNAPSHOT_FOLDER;
  }

  public snapshotPathFor(sourcePath: string): string {
    const normalized = normalizePath(sourcePath);
    const base = (normalized.split("/").pop() || "note").replace(/\.md$/i, "");
    const safe = base.replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/[. ]+$/g, "").slice(0, 64) || "note";
    const suffix = (parseInt(hashContent(normalized), 10) >>> 0).toString(16);
    return normalizePath(`${this.snapshotFolder}/FNS-${safe}-${suffix}.md`);
  }

  public getSnapshotPath(sourcePath: string): string | null {
    const normalized = normalizePath(sourcePath);
    const tracked = this.index.get(normalized);
    if (tracked) {
      const file = this.plugin.app.vault.getAbstractFileByPath(tracked);
      if (file instanceof TFile) return tracked;
      this.index.delete(normalized);
    }
    const candidate = this.snapshotPathFor(normalized);
    const file = this.plugin.app.vault.getAbstractFileByPath(candidate);
    return file instanceof TFile ? candidate : null;
  }

  public getSourceForSnapshot(snapshotPath: string): string | null {
    const normalized = normalizePath(snapshotPath);
    for (const [source, snapshot] of this.index.entries()) {
      if (snapshot === normalized) return source;
    }
    return null;
  }

  public isSnapshotPath(path: string): boolean {
    const normalized = normalizePath(path);
    const folder = this.snapshotFolder;
    return normalized === folder || normalized.startsWith(folder + "/");
  }

  public async bake(file: TFile): Promise<SnapshotBakeResult> {
    const content = await this.plugin.app.vault.read(file);
    const sourceHash = await hashContentAsync(content);
    const render = await this.renderer.render(file);

    const meta: SnapshotMeta = {
      source: normalizePath(file.path),
      sourceMtime: file.stat.mtime,
      sourceSize: file.stat.size,
      sourceHash,
      renderVersion: SNAPSHOT_RENDER_VERSION,
      pluginVersion: this.plugin.manifest.version,
      generated: Date.now(),
    };

    // The fence content must be opaque: markdown/HTML processing would otherwise mangle a raw
    // JSON blob (quotes, `==`, `<`, `#`). We gzip the JSON and base64url-encode it so the fence
    // is a single token of [A-Za-z0-9_-].
    const inner = JSON.stringify({
      v: SNAPSHOT_RENDER_VERSION,
      body: render.bodyClass,
      css: this.gzipBase64(render.css),
    });
    const metaToken = this.base64Url(gzipSync(strToU8(inner)));
    // Meta (body + theme CSS) is opaque (base64url) so markdown can't touch it; the HTML that
    // follows is plain text so the server's share scanner can see and rewrite media refs.
    const payload = `${metaToken}\n${render.html}`;
    const snapshotContent = buildSnapshotContent(meta, payload);
    await this.ensureFolder();
    const snapshotPath = this.snapshotPathFor(file.path);

    const existing = this.plugin.app.vault.getAbstractFileByPath(snapshotPath);
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, snapshotContent);
    } else {
      await this.plugin.app.vault.create(snapshotPath, snapshotContent);
    }

    this.index.set(meta.source, snapshotPath);
    dump(`ShareSnapshot: baked ${meta.source} -> ${snapshotPath}`);
    return { snapshotPath, render, meta };
  }

  public async checkStale(file: TFile): Promise<SnapshotStaleResult> {
    const snapshotPath = this.getSnapshotPath(file.path);
    if (!snapshotPath) return { status: "missing", snapshotPath: null };

    const snapshotFile = this.plugin.app.vault.getAbstractFileByPath(snapshotPath);
    if (!(snapshotFile instanceof TFile)) return { status: "missing", snapshotPath: null };

    const meta = await this.readMeta(snapshotFile);
    if (!meta) return { status: "missing", snapshotPath };

    if (meta.renderVersion !== SNAPSHOT_RENDER_VERSION) return { status: "format", snapshotPath };
    if (meta.sourceMtime !== file.stat.mtime || meta.sourceSize !== file.stat.size) {
      return { status: "changed", snapshotPath };
    }
    return { status: "none", snapshotPath };
  }

  public async deleteSnapshot(snapshotPath: string): Promise<boolean> {
    const file = this.plugin.app.vault.getAbstractFileByPath(snapshotPath);
    if (!(file instanceof TFile)) return false;

    const meta = await this.readMeta(file);
    if (!meta) {
      dump(`ShareSnapshot: refuse to delete non-snapshot note ${snapshotPath}`);
      return false;
    }

    this.removeIndexByValue(snapshotPath);
    try {
      await this.plugin.app.fileManager.trashFile(file);
      dump(`ShareSnapshot: deleted snapshot ${snapshotPath}`);
      return true;
    } catch (e) {
      dumpError("ShareSnapshot: failed to delete snapshot", snapshotPath, e);
      return false;
    }
  }

  /**
   * Delete snapshots whose source note no longer exists and which are not currently shared.
   * `isShared` receives the snapshot path. Returns the affected paths (whether or not deleted).
   */
  public async cleanupOrphans(isShared: (snapshotPath: string) => boolean, dryRun = false): Promise<string[]> {
    const orphans: string[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (!this.isSnapshotPath(file.path)) continue;
      const meta = await this.readMeta(file);
      if (!meta) continue;

      const sourceExists = this.plugin.app.vault.getAbstractFileByPath(meta.source) instanceof TFile;
      if (sourceExists) continue;
      if (isShared(file.path)) continue;

      orphans.push(file.path);
      if (!dryRun) await this.deleteSnapshot(file.path);
    }
    return orphans;
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (!this.isSnapshotPath(file.path)) continue;
      this.registerSnapshotFile(file);
    }
  }

  private registerSnapshotFile(file: TFile): void {
    const meta = parseSnapshotMeta(this.frontmatterOf(file));
    if (meta) this.index.set(normalizePath(meta.source), file.path);
  }

  private async readMeta(file: TFile): Promise<SnapshotMeta | null> {
    const cached = parseSnapshotMeta(this.frontmatterOf(file));
    if (cached) return cached;
    try {
      const data = await this.plugin.app.vault.cachedRead(file);
      return parseSnapshotMeta(parseFrontmatterBlock(data));
    } catch (e) {
      dumpError("ShareSnapshot: failed to read snapshot meta", file.path, e);
      return null;
    }
  }

  private frontmatterOf(file: TFile): Record<string, unknown> | undefined {
    const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter || typeof frontmatter !== "object") return undefined;
    return frontmatter as Record<string, unknown>;
  }

  private removeIndexByValue(snapshotPath: string): void {
    for (const [sourcePath, mapped] of Array.from(this.index.entries())) {
      if (mapped === snapshotPath) this.index.delete(sourcePath);
    }
  }

  private registerVaultEvents(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.isSnapshotPath(file.path)) this.registerSnapshotFile(file);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.removeIndexByValue(file.path);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        void this.handleRename(file, oldPath);
      }),
    );
  }

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(file.path);

    if (this.isSnapshotPath(oldNorm) || this.isSnapshotPath(newNorm)) {
      this.removeIndexByValue(oldNorm);
      if (file instanceof TFile && this.isSnapshotPath(newNorm)) this.registerSnapshotFile(file);
      return;
    }

    const affected = Array.from(this.index.keys()).filter(
      (key) => key === oldNorm || key.startsWith(oldNorm + "/"),
    );
    for (const sourcePath of affected) {
      const snapshotPath = this.index.get(sourcePath);
      if (!snapshotPath) continue;
      const newSource = normalizePath(newNorm + sourcePath.slice(oldNorm.length));
      this.index.delete(sourcePath);
      this.index.set(newSource, snapshotPath);

      const snapshotFile = this.plugin.app.vault.getAbstractFileByPath(snapshotPath);
      if (snapshotFile instanceof TFile) {
        try {
          await this.plugin.app.fileManager.processFrontMatter(snapshotFile, (frontmatter: Record<string, unknown>) => {
            frontmatter["fns-source"] = newSource;
          });
        } catch (e) {
          dumpError("ShareSnapshot: failed to update fns-source after rename", snapshotPath, e);
        }
      }
    }
  }

  private gzipBase64(input: string): string {
    return this.toBase64(gzipSync(strToU8(input)));
  }

  private base64Url(bytes: Uint8Array): string {
    return this.toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  private toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  private async ensureFolder(): Promise<void> {
    const folder = this.snapshotFolder;
    const segments = folder.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.plugin.app.vault.adapter.exists(current))) {
        try {
          await this.plugin.app.vault.createFolder(current);
        } catch (e) {
          dumpError("ShareSnapshot: failed to create folder", current, e);
        }
      }
    }
  }
}

export function isSnapshotMarkerPresent(frontmatter: Record<string, unknown> | null | undefined): boolean {
  return isSnapshotFrontmatter(frontmatter);
}
