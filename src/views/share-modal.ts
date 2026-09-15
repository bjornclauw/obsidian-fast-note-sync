import { App, Modal, setIcon, ButtonComponent, setTooltip, TFile } from "obsidian";
import type FastSync from "../main";
import { $ } from "../i18n/lang";
import { dump, showSyncNotice } from "../lib/utils/helpers";
import { ConfirmModal } from "./confirm-modal";
import { waitForNoteSynced } from "../lib/sync/note_sync_waiter";
import type { SnapshotStaleStatus } from "../lib/share/share_snapshot_manager";

// 过期选项对应的秒数（1 天 / 7 天 / 30 天），"never" 表示永久，"keep" 表示编辑时保持现有有效期不变
const EXPIRE_DURATIONS: Record<string, number> = {
    "1d": 86400,
    "7d": 7 * 86400,
    "30d": 30 * 86400,
};

export class ShareModal extends Modal {
    private plugin: FastSync;
    private path: string;
    private loading: boolean = false;
    private shareData: { id: number, token: string, isPassword?: boolean, shortLink?: string, baseUrl?: string, expiresAt?: string } | null = null;
    private mode: "source" | "rendered" = "source";
    private activeMode: "source" | "rendered" | null = null;
    private targetPath: string = "";
    private snapshotPath: string | null = null;
    private stale: SnapshotStaleStatus = "missing";

    // 密码状态相关
    private isPasswordVisible: boolean = false;
    private passwordValue: string = "";
    private isPasswordDirty: boolean = false;

    // 有效期状态相关
    private expireCreateValue: string = "never";
    private expireEditValue: string = "keep";
    private isExpireDirty: boolean = false;

    constructor(app: App, plugin: FastSync, path: string) {
        super(app);
        this.plugin = plugin;
        this.path = path;
    }

    onOpen() {
        void this.checkShareStatus();
    }

    private async checkShareStatus() {
        if (!this.plugin.websocket || !this.plugin.websocket.isAuth) {
            this.render();
            return;
        }
        this.loading = true;
        this.render();

        const manager = this.plugin.shareSnapshotManager;
        const sourceFile = this.app.vault.getAbstractFileByPath(this.path);
        const snapshotPath = manager?.getSnapshotPath(this.path) ?? null;
        this.snapshotPath = snapshotPath;

        const sourceShare = await this.plugin.api.getShare(this.path);
        if (sourceShare) {
            this.shareData = sourceShare;
            this.activeMode = "source";
            this.targetPath = this.path;
        } else if (snapshotPath) {
            const snapshotShare = await this.plugin.api.getShare(snapshotPath);
            this.shareData = snapshotShare;
            this.activeMode = snapshotShare ? "rendered" : null;
            this.targetPath = snapshotShare ? snapshotPath : "";
        } else {
            this.shareData = null;
            this.activeMode = null;
            this.targetPath = "";
        }

        if (snapshotPath && sourceFile instanceof TFile && manager) {
            this.stale = (await manager.checkStale(sourceFile)).status;
        } else {
            this.stale = "missing";
        }

        this.mode = this.activeMode ?? (this.plugin.settings.shareSnapshotDefaultMode || "source");
        this.loading = false;
        this.isPasswordDirty = false;
        this.render();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    // 解析服务端返回的 expiresAt（ISO 字符串），Go 零值时间或空值表示永久有效，返回 0
    private parseExpiresAt(iso?: string): number {
        if (!iso) return 0;
        const ts = new Date(iso).getTime();
        if (isNaN(ts) || ts <= 0) return 0;
        return Math.floor(ts / 1000);
    }

    private formatExpiresAt(iso?: string): string {
        const seconds = this.parseExpiresAt(iso);
        if (seconds <= 0) return $("ui.share.expire.never");
        return new Date(seconds * 1000).toLocaleString();
    }

    // 根据下拉选项计算最终写入服务端的 expireAt（unix 秒，0 表示永久），fallbackIso 用于 "keep" 选项
    private resolveExpireAt(value: string, fallbackIso?: string): number {
        if (value === "keep") return this.parseExpiresAt(fallbackIso);
        if (value === "never") return 0;
        const duration = EXPIRE_DURATIONS[value];
        if (!duration) return 0;
        return Math.floor(Date.now() / 1000) + duration;
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("fns-share-modal");

        // 1. Hero Section (Header + File Badge)
        this.titleEl.empty();
        const headerContainer = this.titleEl.createDiv("fns-share-header-group");
        const titleIcon = headerContainer.createSpan("fns-share-title-icon");
        setIcon(titleIcon, "share-2");
        headerContainer.createSpan({ text: $("ui.share.title") });

        const container = contentEl.createDiv("fns-share-container");

        // File Badge
        const fileBadge = container.createDiv("fns-file-badge");
        const fileIcon = fileBadge.createSpan("fns-file-icon");
        setIcon(fileIcon, "file-text");
        fileBadge.createSpan({ text: this.path.split("/").pop() || this.path });
        setTooltip(fileBadge, this.path);

        // offline check
        if (!this.plugin.websocket || !this.plugin.websocket.isAuth) {
            const emptyState = container.createDiv("fns-share-empty-state");
            
            const emptyIcon = emptyState.createDiv("fns-empty-icon");
            setIcon(emptyIcon, "wifi-off");
            
            emptyState.createDiv({ text: $("setting.remote.disconnected"), cls: "fns-empty-text" });
            return;
        }
 
        if (this.loading) {
            const loadingEl = container.createDiv("fns-share-loading-state");
            loadingEl.createDiv("fns-spinner");
            loadingEl.createDiv({ text: $("ui.share.checking"), cls: "fns-loading-text" });
            return;
        }

        if (this.shareData) {
            this.renderShareResult(container);
        } else {
            this.renderCreateButton(container);
        }
    }

    private renderCreateButton(parent: HTMLElement) {
        const emptyState = parent.createDiv("fns-share-empty-state");
        const emptyIcon = emptyState.createDiv("fns-empty-icon");
        setIcon(emptyIcon, "share-2");

        emptyState.createDiv({ text: $("ui.share.not_shared_yet"), cls: "fns-empty-text" });

        // 分享模式选择 / Share mode select (source markdown vs rendered snapshot)
        const modeGroup = emptyState.createDiv("fns-share-expire-select-group");
        modeGroup.createSpan({ text: $("setting.share.mode_label"), cls: "fns-share-expire-label" });
        const modeSelect = modeGroup.createEl("select", { cls: "fns-share-expire-select" });
        const modeOptions: [string, string][] = [
            ["source", $("setting.share.mode.source")],
            ["rendered", $("setting.share.mode.rendered")],
        ];
        for (const [value, label] of modeOptions) {
            const opt = modeSelect.createEl("option", { text: label, value });
            if (value === this.mode) opt.selected = true;
        }
        modeSelect.addEventListener("change", () => {
            this.mode = modeSelect.value === "rendered" ? "rendered" : "source";
        });

        // 过期时间选择（创建前）
        const expireGroup = emptyState.createDiv("fns-share-expire-select-group");
        expireGroup.createSpan({ text: $("ui.share.expire.label"), cls: "fns-share-expire-label" });
        const expireSelect = expireGroup.createEl("select", { cls: "fns-share-expire-select" });
        const createOptions: [string, string][] = [
            ["never", $("ui.share.expire.never")],
            ["1d", $("ui.share.expire.1d")],
            ["7d", $("ui.share.expire.7d")],
            ["30d", $("ui.share.expire.30d")],
        ];
        for (const [value, label] of createOptions) {
            const opt = expireSelect.createEl("option", { text: label, value });
            if (value === this.expireCreateValue) opt.selected = true;
        }
        expireSelect.addEventListener("change", () => {
            this.expireCreateValue = expireSelect.value;
        });

        const btn = new ButtonComponent(emptyState)
            .setButtonText(this.loading ? $("ui.share.button_creating") : $("ui.share.create"))
            .setCta()
            .setDisabled(this.loading)
            .onClick(async () => {
                await this.doCreate();
            });
        btn.buttonEl.addClass("fns-share-create-btn");
    }

    private async doCreate() {
        this.loading = true;
        this.render();
        const expireAt = this.resolveExpireAt(this.expireCreateValue);
        const res = this.mode === "rendered"
            ? await this.createRenderedShare(expireAt)
            : await this.plugin.api.createShare(this.path, expireAt);
        this.loading = false;
        if (res) {
            this.shareData = res;
            this.activeMode = this.mode;
            this.targetPath = this.mode === "rendered" ? (this.snapshotPath || this.path) : this.path;
            showSyncNotice($("ui.share.success"));
            void this.plugin.shareIndicatorManager?.addSharedPath(this.targetPath);
        }
        this.render();
    }

    private async createRenderedShare(expireAt: number) {
        const manager = this.plugin.shareSnapshotManager;
        const sourceFile = this.app.vault.getAbstractFileByPath(this.path);
        if (!manager || !(sourceFile instanceof TFile)) {
            showSyncNotice($("ui.share.rendered_unavailable"));
            return null;
        }
        const { snapshotPath, render } = await manager.bake(sourceFile);
        this.snapshotPath = snapshotPath;
        if (render.timedOut) dump(`ShareModal: render settle timed out for ${this.path}`);
        if (render.unrenderable.length > 0) {
            showSyncNotice($("ui.share.rendered_partial", { langs: render.unrenderable.join(", ") }));
        }
        await waitForNoteSynced(snapshotPath, 8000);
        this.stale = "none";
        return await this.plugin.api.createShare(snapshotPath, expireAt);
    }

    private async switchMode(newMode: "source" | "rendered") {
        if (newMode === this.activeMode) {
            this.mode = newMode;
            this.render();
            return;
        }
        this.loading = true;
        this.render();

        const oldTarget = this.targetPath || this.path;
        await this.plugin.api.cancelShare(oldTarget);
        void this.plugin.shareIndicatorManager?.removeSharedPath(oldTarget);

        const expireAt = this.resolveExpireAt("keep", this.shareData?.expiresAt);
        let res: { id: number; token: string; isPassword?: boolean; shortLink?: string; baseUrl?: string; expiresAt?: string } | null = null;
        if (newMode === "rendered") {
            res = await this.createRenderedShare(expireAt);
        } else {
            res = await this.plugin.api.createShare(this.path, expireAt);
            if (this.snapshotPath) {
                await this.plugin.shareSnapshotManager?.deleteSnapshot(this.snapshotPath);
                this.snapshotPath = null;
            }
        }

        this.shareData = res;
        this.activeMode = res ? newMode : null;
        this.targetPath = res ? (newMode === "rendered" ? (this.snapshotPath || this.path) : this.path) : "";
        this.mode = newMode;
        this.loading = false;
        this.render();
    }

    private async rebuildSnapshot() {
        const manager = this.plugin.shareSnapshotManager;
        const sourceFile = this.app.vault.getAbstractFileByPath(this.path);
        if (!manager || !(sourceFile instanceof TFile)) return;
        this.loading = true;
        this.render();
        const { snapshotPath } = await manager.bake(sourceFile);
        this.snapshotPath = snapshotPath;
        await waitForNoteSynced(snapshotPath, 8000);
        this.stale = "none";
        this.loading = false;
        this.render();
    }

    private renderShareResult(parent: HTMLElement) {
        const resultContainer = parent.createDiv("fns-share-result-layout");
        
        // 创建统一的主卡片容器 / Create a single main card container
        const mainCard = resultContainer.createDiv("fns-share-card");

        // --- 0. 分享模式部分 (Mode Section) ---
        const modeSection = mainCard.createDiv("fns-share-section");
        const modeHeader = modeSection.createDiv("fns-share-card-header");
        setIcon(modeHeader.createSpan("fns-header-icon"), "layout-template");
        modeHeader.createSpan({ text: $("setting.share.mode_label"), cls: "fns-header-title" });

        const modeActionGroup = modeSection.createDiv("fns-share-input-group");
        const editModeSelect = modeActionGroup.createEl("select", { cls: "fns-share-expire-select" });
        const editModeOptions: [string, string][] = [
            ["source", $("setting.share.mode.source")],
            ["rendered", $("setting.share.mode.rendered")],
        ];
        for (const [value, label] of editModeOptions) {
            const opt = editModeSelect.createEl("option", { text: label, value });
            if (value === this.activeMode) opt.selected = true;
        }
        editModeSelect.disabled = this.loading;
        editModeSelect.addEventListener("change", () => {
            void this.switchMode(editModeSelect.value === "rendered" ? "rendered" : "source");
        });

        if (this.activeMode === "rendered" && this.stale !== "none") {
            const banner = modeSection.createDiv("fns-share-stale-banner");
            banner.createSpan({
                text: this.stale === "missing" ? $("ui.share.snapshot_missing") : $("ui.share.snapshot_stale"),
            });
            const rebuildBtn = new ButtonComponent(banner)
                .setButtonText($("ui.share.rebuild"))
                .setCta()
                .setDisabled(this.loading)
                .onClick(() => {
                    void this.rebuildSnapshot();
                });
            rebuildBtn.buttonEl.addClass("fns-share-create-btn");
        }

        // --- 1. 分享链接部分 (Link Section) ---
        const linkSection = mainCard.createDiv("fns-share-section");
        const linkHeader = linkSection.createDiv("fns-share-card-header");
        setIcon(linkHeader.createSpan("fns-header-icon"), "globe");
        linkHeader.createSpan({ text: $("ui.share.link"), cls: "fns-header-title" });

        const apiBase = this.shareData?.baseUrl || (this.plugin.runApi || this.plugin.settings.api).replace(/\/+$/, "");
        const shareUrl = `${apiBase}/share/${this.shareData?.id}/${this.shareData?.token}`;

        const linkActionGroup = linkSection.createDiv("fns-share-input-group");
        
        const linkInputWrapper = linkActionGroup.createDiv("fns-input-wrapper");
        const linkInput = linkInputWrapper.createEl("input", {
            type: "text",
            value: shareUrl,
            cls: "fns-share-input"
        });
        linkInput.readOnly = true;

        const linkCopyBtn = new ButtonComponent(linkInputWrapper)
            .setIcon("copy")
            .setTooltip($("ui.share.copy"));
        linkCopyBtn.buttonEl.addClass("fns-input-action-btn");
        linkCopyBtn.onClick(() => {
            void navigator.clipboard.writeText(shareUrl);
            showSyncNotice($("ui.share.copy_success"));
        });

        const externalBtn = new ButtonComponent(linkActionGroup)
            .setIcon("external-link")
            .setTooltip($("ui.share.viewShare"));
        externalBtn.buttonEl.addClass("fns-share-icon-btn");
        externalBtn.onClick(() => window.open(shareUrl, "_blank"));


        // --- 2. 访问密码部分 (Password Section) ---
        const pwdSection = mainCard.createDiv("fns-share-section");
        const pwdHeader = pwdSection.createDiv("fns-share-card-header");
        setIcon(pwdHeader.createSpan("fns-header-icon"), "lock");
        pwdHeader.createSpan({ text: $("ui.share.password"), cls: "fns-header-title" });

        const pwdActionGroup = pwdSection.createDiv("fns-share-input-group");
        const pwdInputWrapper = pwdActionGroup.createDiv("fns-input-wrapper");

        let displayValue = this.passwordValue;
        if (this.shareData?.isPassword && !this.isPasswordVisible && !this.passwordValue) {
            displayValue = "******";
        }

        const pwdInput = pwdInputWrapper.createEl("input", {
            type: this.isPasswordVisible ? "text" : "password",
            value: displayValue,
            placeholder: $("ui.share.passwordPlaceholder"),
            cls: "fns-share-input"
        });

        const eyeBtn = new ButtonComponent(pwdInputWrapper)
            .setIcon(this.isPasswordVisible ? "eye-off" : "eye");
        eyeBtn.buttonEl.addClass("fns-input-action-btn");
        eyeBtn.onClick(() => {
            this.isPasswordVisible = !this.isPasswordVisible;
            if (this.isPasswordVisible && this.shareData?.isPassword && !this.passwordValue) {
                this.passwordValue = "";
            }
            this.render();
        });

        const savePwdBtn = new ButtonComponent(pwdActionGroup)
            .setIcon("check")
            .setTooltip($("ui.common.save"))
            .setDisabled(this.loading);
        savePwdBtn.buttonEl.addClass("fns-share-icon-btn");
        if (this.isPasswordDirty) savePwdBtn.buttonEl.addClass("is-dirty");

        pwdInput.addEventListener("input", (e) => {
            this.passwordValue = (e.target as HTMLInputElement).value;
            this.isPasswordDirty = true;
            savePwdBtn.buttonEl.addClass("is-dirty");
        });

        const doSavePassword = async () => {
            this.loading = true;
            this.render();
            const expireAt = this.resolveExpireAt(this.expireEditValue, this.shareData?.expiresAt);
            const success = await this.plugin.api.updateSharePassword(this.path, this.passwordValue, expireAt);
            this.loading = false;
            if (success) {
                showSyncNotice($("ui.common.saveSuccess"));
                this.shareData!.isPassword = !!this.passwordValue;
                this.shareData!.expiresAt = expireAt > 0 ? new Date(expireAt * 1000).toISOString() : undefined;
                this.isPasswordDirty = false;
                this.isExpireDirty = false;
                this.expireEditValue = "keep";
                if (this.passwordValue) {
                    this.passwordValue = "";
                    this.isPasswordVisible = false;
                }
            }
            this.render();
        };

        savePwdBtn.onClick(async () => {
            if (!this.isPasswordDirty && !this.isExpireDirty) {
                showSyncNotice($("ui.common.noChange"));
                return;
            }
            // 单独修改有效期且未触碰密码框时，服务端会以空密码覆盖现有密码，需先提示确认
            if (this.isExpireDirty && !this.isPasswordDirty && this.shareData?.isPassword) {
                new ConfirmModal(
                    this.app,
                    $("ui.share.expire.confirmTitle"),
                    $("ui.share.expire.confirmClearPassword"),
                    () => { void doSavePassword(); },
                    undefined,
                    undefined,
                    true
                ).open();
                return;
            }
            await doSavePassword();
        });

        // --- 2.5 有效期部分 (Expiration Section) ---
        const expireSection = mainCard.createDiv("fns-share-section");
        const expireHeader = expireSection.createDiv("fns-share-card-header");
        setIcon(expireHeader.createSpan("fns-header-icon"), "calendar-clock");
        expireHeader.createSpan({ text: $("ui.share.expire.label"), cls: "fns-header-title" });

        const expireActionGroup = expireSection.createDiv("fns-share-input-group");
        expireActionGroup.createSpan({
            text: `${$("ui.share.expire.current")}: ${this.formatExpiresAt(this.shareData?.expiresAt)}`,
            cls: "fns-share-expire-current"
        });

        const editExpireSelect = expireActionGroup.createEl("select", { cls: "fns-share-expire-select" });
        const editOptions: [string, string][] = [
            ["keep", $("ui.share.expire.keep")],
            ["never", $("ui.share.expire.never")],
            ["1d", $("ui.share.expire.1d")],
            ["7d", $("ui.share.expire.7d")],
            ["30d", $("ui.share.expire.30d")],
        ];
        for (const [value, label] of editOptions) {
            const opt = editExpireSelect.createEl("option", { text: label, value });
            if (value === this.expireEditValue) opt.selected = true;
        }
        editExpireSelect.addEventListener("change", () => {
            this.expireEditValue = editExpireSelect.value;
            this.isExpireDirty = this.expireEditValue !== "keep";
            if (this.isExpireDirty) savePwdBtn.buttonEl.addClass("is-dirty");
            this.render();
        });

        // --- 3. 短链接部分 (Short Link Section) ---
        const shortSection = mainCard.createDiv("fns-share-section");
        const shortHeader = shortSection.createDiv("fns-share-card-header");
        setIcon(shortHeader.createSpan("fns-header-icon"), "link-2");
        shortHeader.createSpan({ text: $("ui.share.shortLink"), cls: "fns-header-title" });

        const shortActionGroup = shortSection.createDiv("fns-share-input-group");

        if (this.shareData?.shortLink) {
            const shortInputWrapper = shortActionGroup.createDiv("fns-input-wrapper");
            const shortInput = shortInputWrapper.createEl("input", {
                type: "text",
                value: this.shareData.shortLink,
                cls: "fns-share-input"
            });
            shortInput.readOnly = true;

            const shortCopyBtn = new ButtonComponent(shortInputWrapper)
                .setIcon("copy")
                .setTooltip($("ui.share.shortLinkCopy"));
            shortCopyBtn.buttonEl.addClass("fns-input-action-btn");
            shortCopyBtn.onClick(() => {
                void navigator.clipboard.writeText(this.shareData!.shortLink!);
                showSyncNotice($("ui.share.copy_success"));
            });
            
            const refreshBtn = new ButtonComponent(shortActionGroup)
                .setIcon("refresh-cw")
                .setTooltip($("ui.share.shortLinkCreate"))
                .setDisabled(this.loading);
            refreshBtn.buttonEl.addClass("fns-share-icon-btn");
            refreshBtn.onClick(async () => {
                refreshBtn.setDisabled(true);
                const newShortLink = await this.plugin.api.createShortLink(this.path, true, shareUrl);
                if (newShortLink) {
                    this.shareData!.shortLink = newShortLink;
                    this.render();
                }
                refreshBtn.setDisabled(false);
            });

        } else {
            const shortInputWrapper = shortActionGroup.createDiv("fns-input-wrapper");
            
            const shortInput = shortInputWrapper.createEl("input", {
                type: "text",
                placeholder: $("ui.share.shortLink"),
                cls: "fns-share-input"
            });
            shortInput.readOnly = true; // 占位显示

            const createShortBtn = new ButtonComponent(shortActionGroup)
                .setIcon("plus-circle")
                .setTooltip($("ui.share.shortLinkCreate"))
                .setDisabled(this.loading);
            createShortBtn.buttonEl.addClass("fns-share-icon-btn");
            createShortBtn.onClick(async () => {
                this.loading = true;
                this.render();
                const shortLink = await this.plugin.api.createShortLink(this.path, false, shareUrl);
                this.loading = false;
                if (shortLink) {
                    this.shareData!.shortLink = shortLink;
                }
                this.render();
            });
        }

        // --- 4. Footer Section ---
        const footer = resultContainer.createDiv("fns-share-footer-v2");
        
        const statusTip = footer.createDiv("fns-share-status-tip");
        setIcon(statusTip.createSpan(), "check-circle-2");
        statusTip.createSpan({ text: $("ui.share.success") });

        const cancelBtn = new ButtonComponent(footer)
            .setDisabled(this.loading)
            .onClick(async () => {
                this.loading = true;
                this.render();
                const cancelTarget = this.targetPath || this.path;
                const wasRendered = this.activeMode === "rendered";
                const success = await this.plugin.api.cancelShare(cancelTarget);
                this.loading = false;
                if (success) {
                    if (wasRendered && this.snapshotPath) {
                        await this.plugin.shareSnapshotManager?.deleteSnapshot(this.snapshotPath);
                    }
                    this.shareData = null;
                    this.activeMode = null;
                    this.targetPath = "";
                    this.snapshotPath = null;
                    this.stale = "missing";
                    this.mode = this.plugin.settings.shareSnapshotDefaultMode || "source";
                    this.passwordValue = "";
                    this.isPasswordVisible = false;
                    this.isPasswordDirty = false;
                    showSyncNotice($("ui.share.cancel_success"));
                    void this.plugin.shareIndicatorManager?.removeSharedPath(cancelTarget);
                }
                this.render();
            });
        
        cancelBtn.buttonEl.addClass("fns-share-cancel-btn");
        cancelBtn.buttonEl.empty();
        setIcon(cancelBtn.buttonEl.createSpan(), "unlink"); 
        cancelBtn.buttonEl.createSpan({ text: $("ui.share.cancel") });
    }
}
