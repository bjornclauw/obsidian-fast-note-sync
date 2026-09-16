import { Component, FileSystemAdapter, MarkdownRenderer, normalizePath, TFile } from "obsidian";

import type FastSync from "../../main";
import { dump, dumpError } from "../utils/helpers";

// Async post-processors (e.g. Dataview) fill their content after MarkdownRenderer.render resolves.
// There is no official "render complete" event, so settle once the DOM stops mutating for a quiet
// period, with a hard timeout as a safety net.
const SETTLE_QUIET_MS = 400;
const SETTLE_TIMEOUT_MS = 5000;

// Fenced-code languages whose owning plugin renders them into live DOM. If a block is still a plain
// code element after settling, the plugin is missing/failed and the snapshot will not show it.
const PLUGIN_OWNED_LANGUAGES = ["dataview", "dataviewjs", "excalidraw", "chart"];

export interface NoteRenderResult {
  html: string;
  css: string;
  bodyClass: string;
  timedOut: boolean;
  unrenderable: string[];
}

export class NoteRenderer {
  constructor(private plugin: FastSync) {}

  public async render(file: TFile): Promise<NoteRenderResult> {
    const app = this.plugin.app;
    const source = await app.vault.cachedRead(file);

    const container = createDiv();
    const component = new Component();
    component.load();

    let timedOut = false;
    let html = "";
    let css = "";
    let bodyClass = "";
    let unrenderable: string[] = [];

    try {
      await MarkdownRenderer.render(app, source, container, file.path, component);
      timedOut = await this.settle(container);
      await this.inlineResources(container);
      await this.resolveInternalLinks(container, file.path);

      // IMPORTANT: capture BEFORE component.unload(). Plugins that register their widget via
      // ctx.addChild (e.g. card-grid) wipe their DOM in onunload -> destroy() -> container.empty(),
      // so serializing after unload yields an emptied shell.
      html = this.wrapPreview(container.innerHTML);
      css = this.collectDocumentCss();
      bodyClass = this.detectBodyClasses();
      unrenderable = PLUGIN_OWNED_LANGUAGES.filter((lang) =>
        container.querySelector(`code.language-${lang}`) !== null,
      );
    } catch (e) {
      dumpError("ShareSnapshot: failed to render note", file.path, e);
    } finally {
      try {
        component.unload();
      } catch (e) {
        dumpError("ShareSnapshot: component unload failed", e);
      }
    }

    if (unrenderable.length > 0) {
      dump(`ShareSnapshot: unrendered plugin blocks in ${file.path}: ${unrenderable.join(", ")}`);
    }

    return { html, css, bodyClass, timedOut, unrenderable };
  }

  // Wrap in Obsidian's reading-view containers so theme/app CSS applies exactly as in-app.
  private wrapPreview(inner: string): string {
    return `<div class="markdown-preview-view markdown-rendered"><div class="markdown-preview-sizer markdown-preview-section">${inner}</div></div>`;
  }

  // Serialize the active stylesheets (app.css + theme + snippets + plugin CSS) so the share
  // viewer can render pixel-accurately. Cross-origin sheets are skipped.
  private collectDocumentCss(): string {
    const parts: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules;
        if (!rules) continue;
        for (const rule of Array.from(rules)) parts.push(rule.cssText);
      } catch {
        // inaccessible (cross-origin) sheet
      }
    }
    const cssText = parts.join("\n");
    // The viewer renders this in a shadow root where :root/body selectors don't apply, so bake the
    // resolved custom properties explicitly onto the note root.
    return this.buildResolvedVariables(cssText) + "\n" + cssText;
  }

  private buildResolvedVariables(cssText: string): string {
    const names = new Set<string>();
    const re = /(--[a-zA-Z0-9_-]+)\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(cssText)) !== null) names.add(match[1]);
    const computed = getComputedStyle(document.body);
    const decls: string[] = [];
    for (const name of names) {
      const value = computed.getPropertyValue(name).trim();
      if (value) decls.push(`${name}:${value};`);
    }
    return `.fns-rendered-root{${decls.join("")}}`;
  }

  private detectBodyClasses(): string {
    const body = document.body;
    const keep = Array.from(body.classList).filter(
      (cls) => cls === "theme-dark" || cls === "theme-light" || cls.startsWith("is-"),
    );
    if (!keep.includes("theme-dark") && !keep.includes("theme-light")) {
      keep.push(body.classList.contains("theme-dark") ? "theme-dark" : "theme-light");
    }
    return keep.join(" ");
  }

  private settle(el: HTMLElement): Promise<boolean> {
    return new Promise((resolve) => {
      let quietTimer: number | null = null;
      let hardTimer: number | null = null;
      let finished = false;

      const observer = new MutationObserver(() => arm());

      const finish = (didTimeOut: boolean) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        if (quietTimer !== null) window.clearTimeout(quietTimer);
        if (hardTimer !== null) window.clearTimeout(hardTimer);
        resolve(didTimeOut);
      };

      const arm = () => {
        if (quietTimer !== null) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => finish(false), SETTLE_QUIET_MS);
      };

      observer.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
      hardTimer = window.setTimeout(() => finish(true), SETTLE_TIMEOUT_MS);
      window.requestAnimationFrame(() => arm());
    });
  }

  // Rewrite Obsidian-local resource URLs (app://, file://, absolute paths) to vault-relative
  // paths. The path is left in `src` on purpose: when the snapshot note is served as a share, the
  // server scans the content for <img src>/<video src>/... and rewrites them to authorized
  // /api/share/file URLs, adding the files to the share. (The viewer cannot mint those URLs.)
  private async inlineResources(container: HTMLElement): Promise<void> {
    container.querySelectorAll<HTMLElement>("img, video, audio, source").forEach((el) => {
      const raw = el.getAttribute("src");
      if (!raw || /^(data:|https?:|blob:)/i.test(raw)) return;
      const vaultPath = this.resolveResourceToVaultPath(raw);
      if (!vaultPath) return;
      el.setAttribute("src", vaultPath);
      el.removeAttribute("data-fns-src");
    });
    container.querySelectorAll<HTMLElement>("[srcset]").forEach((el) => el.removeAttribute("srcset"));
  }

  // Rewrite internal note links to the target note's share URL when that note is also shared, so
  // published pages can navigate to each other. External links and anchors are left untouched.
  private async resolveInternalLinks(container: HTMLElement, sourcePath: string): Promise<void> {
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    if (anchors.length === 0) return;
    const base = (this.plugin.runApi || this.plugin.settings.api || "").replace(/\/+$/, "");
    if (!base) return;

    const cache = new Map<string, { id: number; token: string; baseUrl?: string } | null>();
    for (const a of anchors) {
      const target = a.getAttribute("data-href") || a.getAttribute("href") || "";
      if (!target || /^(?:https?:|mailto:|tel:|#)/i.test(target)) continue;

      const [linkPath, anchor] = target.split("#");
      const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
      if (!dest) continue;

      const path = dest.path;
      // Tag the anchor with the target note path so the server can resolve it to the target's
      // share URL at serve time (dynamic: publishing a target needs no re-bake of this page).
      a.setAttribute("data-fns-link", path);
      let share = cache.get(path);
      if (share === undefined) {
        try {
          // The target may be shared as "source" (share on the note path) or as a rendered
          // snapshot (share on the snapshot path) — check both.
          share = await this.plugin.api.getShare(path);
          if (!share) {
            const snapshotPath = this.plugin.shareSnapshotManager?.getSnapshotPath(path);
            if (snapshotPath) share = await this.plugin.api.getShare(snapshotPath);
          }
        } catch (e) {
          dumpError("ShareSnapshot: failed to resolve share for internal link", path, e);
          share = null;
        }
        cache.set(path, share);
      }
      if (!share) continue;

      const shareBase = (share.baseUrl || base).replace(/\/+$/, "");
      a.setAttribute("href", `${shareBase}/share/${share.id}/${share.token}${anchor ? "#" + anchor : ""}`);
      a.removeAttribute("data-href");
      a.classList.remove("is-unresolved");
    }
  }

  private resolveResourceToVaultPath(url: string): string | null {
    if (!url) return null;
    if (/^(data:|https?:|blob:)/i.test(url)) return null;

    let raw = url;
    if (raw.startsWith("app://")) {
      const rest = raw.slice("app://".length);
      const slash = rest.indexOf("/");
      if (slash === -1) return null;
      raw = rest.slice(slash + 1);
    } else if (raw.startsWith("file://")) {
      raw = raw.slice("file://".length).replace(/^\/([A-Za-z]:)/, "$1");
    }

    raw = raw.split("#")[0].split("?")[0];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // keep raw when decoding fails
    }
    raw = raw.replace(/\\/g, "/");

    const base = this.vaultBasePath();
    if (base) {
      const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
      if (raw.startsWith(normBase + "/")) raw = raw.slice(normBase.length + 1);
      else if (raw.startsWith(normBase)) raw = raw.slice(normBase.length).replace(/^\/+/, "");
    }

    raw = raw.replace(/^\/+/, "");
    if (!raw) return null;
    return normalizePath(raw);
  }

  private vaultBasePath(): string | null {
    const adapter = this.plugin.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      try {
        return adapter.getBasePath();
      } catch {
        return null;
      }
    }
    return null;
  }
}
