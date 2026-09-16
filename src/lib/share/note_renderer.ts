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
    return parts.join("\n");
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

  // Replace Obsidian-local resource URLs (app://, file://, absolute paths) with a stable
  // vault-relative token the share viewer can resolve. We move the path into `data-fns-src` and
  // drop `src` so the browser never tries to load an unresolvable app:// URL.
  private async inlineResources(container: HTMLElement): Promise<void> {
    container.querySelectorAll<HTMLElement>("img, video, audio, source").forEach((el) => {
      const raw = el.getAttribute("src");
      if (!raw) return;
      const vaultPath = this.resolveResourceToVaultPath(raw);
      if (!vaultPath) return;
      el.setAttribute("data-fns-src", vaultPath);
      el.removeAttribute("src");
    });
    container.querySelectorAll<HTMLElement>("[srcset]").forEach((el) => el.removeAttribute("srcset"));
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
