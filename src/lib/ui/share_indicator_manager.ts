import type FastSync from "../../main";

export class ShareIndicatorManager {
    // 内存中的分享路径集合 / In-memory set of shared paths
    private sharedPaths: Set<string> = new Set();
    // 筛选是否激活 / Whether the filter is active
    private _isFilterActive = false;
    // 网络重连处理器引用 / Online handler ref
    private onlineHandler: (() => void) | null = null;
    // 启动延迟定时器 / Startup delay timer
    private startupTimer: number | null = null;
    // 并发同步守卫 / Concurrent sync guard
    private isSyncing = false;
    // DOM 观察器 / DOM Observer
    private observer: MutationObserver | null = null;

    constructor(private plugin: FastSync) {}

    /**
     * 初始化
     */
    async initialize(): Promise<void> {
        if (this.startupTimer !== null) {
            window.clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        if (this.onlineHandler) {
            window.removeEventListener('online', this.onlineHandler);
            this.onlineHandler = null;
        }

        const saved = this.plugin.settings.sharedPaths ?? [];
        this.sharedPaths = new Set(saved);

        this.onlineHandler = () => {
            void (async () => {
                await this.syncWithServer();
            })().catch(() => {});
        };
        window.addEventListener("online", this.onlineHandler);

        this.startupTimer = window.setTimeout(() => {
            void this.syncWithServer().catch(() => {});
        }, 5000);

        // 启动 DOM 观察器
        this.startObserver();

        this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => {
            void this.removeSharedPath(file.path);
        }));
    }

    private startObserver() {
        if (this.observer) return;

        this.observer = new MutationObserver(() => {
            this.updateAllElements();
            this.updateSnapshotFolderVisibility();
        });

        // 观察整个 body，因为文件浏览器可能会被销毁和重建
        this.observer.observe(activeDocument.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-path', 'data-drag-path']
        });

        // 初始更新
        this.updateAllElements();
        this.updateSnapshotFolderVisibility();
    }

    // 按设置隐藏/显示生成的快照文件夹（文件浏览器中的装饰性隐藏）
    // Hide/show the generated snapshot folder per setting (cosmetic hide in the file explorer)
    private updateSnapshotFolderVisibility(): void {
        const hide = this.plugin.settings.shareSnapshotHideFolder !== false;
        activeDocument.body.toggleClass("fns-hide-snapshot-folder", hide);

        const folder = this.plugin.shareSnapshotManager?.snapshotFolder;
        activeDocument.querySelectorAll<HTMLElement>(".nav-folder-title[data-path]").forEach((titleEl) => {
            const container = titleEl.closest<HTMLElement>(".nav-folder");
            if (!container) return;
            if (hide && folder && titleEl.getAttribute("data-path") === folder) {
                container.setAttribute("data-fns-snapshot-folder", "true");
            } else if (container.hasAttribute("data-fns-snapshot-folder")) {
                container.removeAttribute("data-fns-snapshot-folder");
            }
        });
    }

    public refreshSnapshotFolderVisibility(): void {
        this.updateSnapshotFolderVisibility();
    }

    private updateAllElements() {
        if (!this.plugin.settings.showShareIcon) return;

        const sharedPaths = this.sharedPaths;
        const ancestorFolders = this.getAllAncestorFolders();

        // 处理原生文件浏览器
        activeDocument.querySelectorAll('.nav-file-title, .nav-folder-title').forEach(el => {
            const path = el.getAttribute('data-path');
            if (!path) return;

            const isShared = sharedPaths.has(path) || ancestorFolders.has(path);
            // 用 closest 命中真正的 .nav-file / .nav-folder 容器：某些插件/主题会在
            // 标题外再包一层，此时 parentElement 不是容器，会导致该行无法被筛选保留
            // Use closest() so the mark lands on the real .nav-file / .nav-folder container;
            // some plugins/themes wrap the title, so parentElement is not the container.
            const targetEl = el.closest('.nav-file, .nav-folder') ?? el.parentElement ?? el;
            
            if (isShared) {
                if (targetEl.getAttribute('data-fns-shared') !== 'true') {
                    targetEl.setAttribute('data-fns-shared', 'true');
                }
                if (el.getAttribute('data-fns-shared') !== 'true') {
                    el.setAttribute('data-fns-shared', 'true');
                }
            } else {
                if (targetEl.hasAttribute('data-fns-shared')) {
                    targetEl.removeAttribute('data-fns-shared');
                }
                if (el.hasAttribute('data-fns-shared')) {
                    el.removeAttribute('data-fns-shared');
                }
            }
        });

        // 处理 Notebook Navigator 等第三方插件 (使用 data-drag-path)
        activeDocument.querySelectorAll('[data-drag-path]').forEach(el => {
            const path = el.getAttribute('data-drag-path');
            if (!path) return;

            const isShared = sharedPaths.has(path);
            if (isShared) {
                if (el.getAttribute('data-fns-shared') !== 'true') {
                    el.setAttribute('data-fns-shared', 'true');
                }
            } else {
                if (el.hasAttribute('data-fns-shared')) {
                    el.removeAttribute('data-fns-shared');
                }
            }
        });
    }

    updateSharedPaths(paths: string[]): void {
        const uiPaths = this.toUiPaths(paths);
        this.sharedPaths = new Set(uiPaths);
        this.plugin.settings.sharedPaths = uiPaths;
        void this.plugin.saveSettings();
        this.updateAllElements();
    }

    // 将服务端分享路径映射为“对用户有意义”的路径：渲染分享的快照映射回原始笔记，
    // 这样浏览器高亮/筛选的是原始文件，而不是生成的快照。
    // Map server share paths to user-meaningful paths: rendered snapshots map back to their
    // source note, so the explorer highlights/filters the original file, not the snapshot.
    private toUiPaths(paths: string[]): string[] {
        const manager = this.plugin.shareSnapshotManager;
        const seen = new Set<string>();
        const result: string[] = [];
        for (const path of paths) {
            const mapped = manager?.getSourceForSnapshot(path) ?? path;
            if (!seen.has(mapped)) {
                seen.add(mapped);
                result.push(mapped);
            }
        }
        return result;
    }

    async syncWithServer(): Promise<void> {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            if (!this.plugin.settings.api || !this.plugin.settings.apiToken) return;
            
            // 新增：仅在 WebSocket 认证通过（确保服务端连通）时才获取分享列表
            if (!this.plugin.websocket.isAuth) return;

            const paths = await this.plugin.api.getSharePaths();
            if (paths === null) return;

            const uiPaths = this.toUiPaths(paths);
            const newSet = new Set(uiPaths);
            const changed = !(this.sharedPaths.size === newSet.size && uiPaths.every(p => this.sharedPaths.has(p)));
            if (changed) {
                this.sharedPaths = newSet;
                this.plugin.settings.sharedPaths = uiPaths;
                await this.plugin.saveData(this.plugin.settings);
            }
            // 即使路径集合没变也要重新打标，避免文件树重渲染后标记丢失
            // Re-mark even when the set is unchanged, so marks survive file-tree re-renders
            this.updateAllElements();
        } finally {
            this.isSyncing = false;
        }
    }

    async addSharedPath(path: string): Promise<void> {
        const uiPath = this.plugin.shareSnapshotManager?.getSourceForSnapshot(path) ?? path;
        this.sharedPaths.add(uiPath);
        this.plugin.settings.sharedPaths = Array.from(this.sharedPaths);
        await this.plugin.saveData(this.plugin.settings);
        this.updateAllElements();
        this.plugin.menuManager?.updateShareIconColor();
    }

    async removeSharedPath(path: string): Promise<void> {
        const uiPath = this.plugin.shareSnapshotManager?.getSourceForSnapshot(path) ?? path;
        this.sharedPaths.delete(uiPath);
        this.plugin.settings.sharedPaths = Array.from(this.sharedPaths);
        await this.plugin.saveData(this.plugin.settings);
        this.updateAllElements();
        this.plugin.menuManager?.updateShareIconColor();
        
        if (this._isFilterActive && this.sharedPaths.size === 0) {
            this._isFilterActive = false;
            activeDocument.body.removeClass('fns-filter-active');
        }
    }

    getSharedCount(): number {
        return this.sharedPaths.size;
    }

    hasPath(path: string): boolean {
        return this.sharedPaths.has(path);
    }

    get isFilterActive(): boolean {
        return this._isFilterActive;
    }

    toggleFilter(): void {
        this._isFilterActive = !this._isFilterActive;
        if (this._isFilterActive) {
            // 先刷新标记再启用筛选，避免用过期/缺失的标记过滤
            // Refresh marks before enabling the filter to avoid filtering on stale marks
            this.updateAllElements();
            activeDocument.body.addClass('fns-filter-active');
            this.expandSharedFolders();
            // 展开文件夹后子节点是延迟渲染的，稍后再补一次标记
            // Children render lazily after expanding, so re-mark shortly after
            window.setTimeout(() => this.updateAllElements(), 150);
            window.setTimeout(() => this.updateAllElements(), 600);
        } else {
            activeDocument.body.removeClass('fns-filter-active');
        }
        this.plugin.app.workspace.requestSaveLayout();
    }

    private getAllAncestorFolders(): Set<string> {
        const folders = new Set<string>();
        for (const path of this.sharedPaths) {
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) {
                folders.add(parts.slice(0, i).join("/"));
            }
        }
        return folders;
    }

    private expandSharedFolders(): void {
        const ancestors = this.getAllAncestorFolders();
        if (ancestors.size === 0) return;
        // 避免 :has() 选择器（旧内核/第三方 DOM 结构下可能不生效），改为遍历折叠文件夹
        // Avoid :has() (may fail on older engines / third-party DOM) by iterating collapsed folders
        activeDocument.querySelectorAll<HTMLElement>(".nav-folder.is-collapsed").forEach((folderEl) => {
            const titleEl = folderEl.querySelector<HTMLElement>(":scope > .nav-folder-title");
            const path = titleEl?.getAttribute("data-path");
            if (path && ancestors.has(path)) titleEl?.click();
        });
    }

    unload(): void {
        if (this.startupTimer !== null) {
            window.clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        if (this.onlineHandler) {
            window.removeEventListener("online", this.onlineHandler);
            this.onlineHandler = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        activeDocument.body.removeClass('fns-filter-active');
        activeDocument.body.removeClass('fns-hide-snapshot-folder');
        // 清理所有标记
        activeDocument.querySelectorAll('[data-fns-shared]').forEach(el => el.removeAttribute('data-fns-shared'));
        activeDocument.querySelectorAll('[data-fns-snapshot-folder]').forEach(el => el.removeAttribute('data-fns-snapshot-folder'));
    }

    public regenerateCss(): void {
        this.updateAllElements();
    }
}
