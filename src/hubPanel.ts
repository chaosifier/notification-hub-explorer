import * as vscode from "vscode";
import type { HubInfo, HubStore } from "./hubStore";
import {
  DEFAULT_PAYLOADS,
  HubService,
  PLATFORM_LABELS,
  describeError,
  platformForKind,
  type SendRequest,
} from "./hubService";

export type HubTab = "send" | "registrations";

export interface OpenOptions {
  tab?: HubTab;
  tag?: string;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "loadRegistrations"; tag?: string }
  | { type: "loadMore" }
  | { type: "showDetails"; id: string }
  | { type: "editTags"; id: string; tags: string[] }
  | { type: "deleteRegistrations"; ids: string[] }
  | { type: "sendToDevice"; kind: string; pnsHandle: string }
  | { type: "export"; rows: unknown[] }
  | { type: "send"; request: SendRequest };

/** A webview panel per hub with "Test Send" and "Device Registrations" tabs. */
export class HubPanel {
  private static readonly panels = new Map<string, HubPanel>();

  static async show(
    context: vscode.ExtensionContext,
    store: HubStore,
    output: vscode.OutputChannel,
    hub: HubInfo,
    options: OpenOptions = {},
  ): Promise<void> {
    const existing = HubPanel.panels.get(hub.id);
    if (existing) {
      existing.panel.reveal();
      existing.applyOptions(options);
      return;
    }
    const cs = await store.getConnectionString(hub.id);
    if (!cs) {
      vscode.window.showErrorMessage(`No connection string stored for ${hub.hubName}. Use "Edit Connection" to set one.`);
      return;
    }
    let service: HubService;
    try {
      service = new HubService(cs, hub.hubName);
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create client for ${hub.hubName}: ${describeError(err)}`);
      return;
    }
    HubPanel.panels.set(hub.id, new HubPanel(context, output, hub, service, options));
  }

  /** Closes the panel for a hub (e.g. after it is removed or its connection is edited). */
  static dispose(hubId: string): void {
    HubPanel.panels.get(hubId)?.panel.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private pendingOptions: OpenOptions | undefined;
  private ready = false;
  private loadGeneration = 0;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly hub: HubInfo,
    private readonly service: HubService,
    options: OpenOptions,
  ) {
    this.pendingOptions = options;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel(
      "notificationHubExplorer",
      `Hub: ${hub.hubName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(mediaRoot, "bell.svg");
    this.panel.webview.html = this.renderHtml(mediaRoot);
    this.panel.onDidDispose(() => HubPanel.panels.delete(hub.id), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m), null, context.subscriptions);
  }

  private applyOptions(options: OpenOptions): void {
    if (!this.ready) {
      this.pendingOptions = options;
      return;
    }
    if (options.tab) {
      this.post({ type: "showTab", tab: options.tab });
    }
    if (options.tag !== undefined) {
      this.post({ type: "searchTag", tag: options.tag });
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private get pageSize(): number {
    const size = vscode.workspace.getConfiguration("notificationHubExplorer").get<number>("registrationPageSize", 100);
    return Math.min(100, Math.max(1, Math.floor(size)));
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case "ready": {
        this.ready = true;
        this.post({
          type: "init",
          hub: this.hub,
          platforms: PLATFORM_LABELS,
          defaults: DEFAULT_PAYLOADS,
        });
        const opts = this.pendingOptions ?? {};
        this.pendingOptions = undefined;
        this.applyOptions(opts);
        return;
      }
      case "loadRegistrations":
        return this.runLoad(() => this.service.firstPage(m.tag?.trim() || undefined, this.pageSize), false);
      case "loadMore":
        return this.runLoad(() => this.service.nextPage(), true);
      case "showDetails":
        return this.showDetails(m.id);
      case "editTags":
        return this.editTags(m.id, m.tags);
      case "deleteRegistrations":
        return this.deleteRegistrations(m.ids);
      case "sendToDevice":
        this.post({ type: "prefillDevice", platform: platformForKind(m.kind), pnsHandle: m.pnsHandle });
        return;
      case "export": {
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(m.rows, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      case "send":
        return this.send(m.request);
    }
  }

  private async runLoad(load: () => Promise<{ rows: unknown[]; hasMore: boolean }>, append: boolean): Promise<void> {
    const generation = append ? this.loadGeneration : ++this.loadGeneration;
    this.post({ type: "loading", loading: true });
    try {
      const page = await load();
      if (generation !== this.loadGeneration) {
        return;
      }
      this.post({ type: "registrations", rows: page.rows, hasMore: page.hasMore, append });
    } catch (err) {
      if (generation !== this.loadGeneration) {
        return;
      }
      const msg = describeError(err);
      this.output.appendLine(`[${this.hub.hubName}] Failed to load registrations: ${msg}`);
      this.post({ type: "registrationsError", message: msg });
    } finally {
      if (generation === this.loadGeneration) {
        this.post({ type: "loading", loading: false });
      }
    }
  }

  private async showDetails(id: string): Promise<void> {
    try {
      const reg = await this.service.getRegistration(id);
      const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(reg, null, 2) });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get registration ${id}: ${describeError(err)}`);
    }
  }

  private async editTags(id: string, current: string[]): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: `Edit tags for registration ${id}`,
      prompt: "Comma-separated list of tags",
      value: current.join(", "),
      validateInput: (v) =>
        v.split(",").map((t) => t.trim()).filter(Boolean).some((t) => !/^[A-Za-z0-9_@#.:\-]{1,120}$/.test(t))
          ? "Tags may contain letters, digits and _ @ # . : - (max 120 chars each)"
          : undefined,
    });
    if (value === undefined) {
      return;
    }
    const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      const row = await this.service.updateTags(id, tags);
      this.post({ type: "rowUpdated", row });
      vscode.window.setStatusBarMessage(`Updated tags for ${id}`, 3000);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to update tags: ${describeError(err)}`);
    }
  }

  private async deleteRegistrations(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      ids.length === 1 ? `Delete registration ${ids[0]}?` : `Delete ${ids.length} registrations?`,
      { modal: true, detail: "This cannot be undone." },
      "Delete",
    );
    if (answer !== "Delete") {
      return;
    }
    const deleted: string[] = [];
    const failures: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Deleting registrations" },
      async (progress) => {
        for (const id of ids) {
          try {
            await this.service.deleteRegistration(id);
            deleted.push(id);
          } catch (err) {
            failures.push(`${id}: ${describeError(err)}`);
          }
          progress.report({ increment: 100 / ids.length });
        }
      },
    );
    this.post({ type: "rowsDeleted", ids: deleted });
    if (failures.length) {
      failures.forEach((f) => this.output.appendLine(`[${this.hub.hubName}] Delete failed ${f}`));
      vscode.window.showErrorMessage(`Failed to delete ${failures.length} registration(s). See output for details.`);
      this.output.show(true);
    }
  }

  private async send(request: SendRequest): Promise<void> {
    const started = new Date();
    const target =
      request.target === "broadcast" ? "all devices" : request.target === "tag" ? `tag "${request.tagExpression}"` : "device handle";
    this.output.appendLine(`[${started.toISOString()}] ${this.hub.hubName}: sending ${request.platform} notification to ${target}${request.testSend ? " (test send)" : ""}`);
    try {
      const res = await this.service.send(request);
      this.output.appendLine(
        `  -> state=${res.state} success=${res.successCount} failure=${res.failureCount} notificationId=${res.notificationId ?? "-"} trackingId=${res.trackingId ?? "-"}`,
      );
      for (const r of res.results ?? []) {
        this.output.appendLine(`     ${r.applicationPlatform} ${r.registrationId} ${r.outcome}`);
      }
      this.post({
        type: "sendResult",
        ok: true,
        sentAt: started.toISOString(),
        testSend: request.testSend && request.target !== "device",
        response: {
          state: res.state,
          successCount: res.successCount,
          failureCount: res.failureCount,
          notificationId: res.notificationId,
          trackingId: res.trackingId,
          correlationId: res.correlationId,
          results: res.results ?? [],
        },
      });
    } catch (err) {
      const msg = describeError(err);
      this.output.appendLine(`  -> FAILED: ${msg}`);
      this.post({ type: "sendResult", ok: false, sentAt: started.toISOString(), error: msg });
    }
  }

  private renderHtml(mediaRoot: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "hub.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "hub.css"));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Notification Hub</title>
</head>
<body>
<header>
  <h1 id="hubTitle"></h1>
  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="send" role="tab">Test Send</button>
    <button class="tab" data-tab="registrations" role="tab">Device Registrations</button>
  </nav>
</header>

<section id="tab-send" class="tab-panel active">
  <div class="grid">
    <label for="platform">Platform</label>
    <select id="platform"></select>

    <label>Send to</label>
    <div class="radio-row">
      <label><input type="radio" name="target" value="broadcast" checked> All registered devices</label>
      <label><input type="radio" name="target" value="tag"> Tag expression</label>
      <label><input type="radio" name="target" value="device"> Device handle</label>
    </div>

    <label for="tagExpression" class="target-tag">Tag expression</label>
    <input id="tagExpression" class="target-tag" type="text" placeholder="e.g. user:123 || (sports && !scores)">

    <label for="deviceHandle" class="target-device">Device handle</label>
    <input id="deviceHandle" class="target-device" type="text" placeholder="APNS token / FCM registration id / WNS channel URI">

    <label for="headers">Headers <span class="hint">(optional, JSON)</span></label>
    <textarea id="headers" rows="2" spellcheck="false" placeholder='{ "apns-priority": "10" }'></textarea>

    <label for="body">Message payload</label>
    <div>
      <textarea id="body" rows="14" spellcheck="false"></textarea>
      <div class="hint" id="bodyHint"></div>
    </div>

    <span></span>
    <div class="actions">
      <label class="checkbox" id="testSendWrap"><input type="checkbox" id="testSend" checked> Test send <span class="hint">(returns per-registration outcomes; delivers to at most 10 devices)</span></label>
      <span class="spacer"></span>
      <button id="resetBody" class="secondary">Reset payload</button>
      <button id="sendBtn">Send</button>
    </div>
  </div>

  <h2>Results</h2>
  <div id="sendResults" class="results"><p class="muted">No notifications sent yet.</p></div>
</section>

<section id="tab-registrations" class="tab-panel">
  <div class="toolbar">
    <input id="tagSearch" type="text" placeholder="Search by tag (single tag, exact match) — leave empty for all registrations">
    <button id="searchBtn">Search</button>
    <button id="clearBtn" class="secondary">Show all</button>
    <span class="spacer"></span>
    <input id="filterText" type="text" placeholder="Filter loaded rows…" class="narrow">
    <select id="kindFilter"><option value="">All platforms</option></select>
  </div>
  <div class="toolbar">
    <span id="regStatus" class="muted"></span>
    <span class="spacer"></span>
    <button id="deleteSelected" class="secondary" disabled>Delete selected</button>
    <button id="exportBtn" class="secondary">Export JSON</button>
  </div>
  <div class="table-wrap">
    <table id="regTable">
      <thead>
        <tr>
          <th class="col-check"><input type="checkbox" id="selectAll" title="Select all"></th>
          <th data-sort="kind">Platform</th>
          <th data-sort="registrationId">Registration ID</th>
          <th data-sort="tags">Tags</th>
          <th data-sort="pnsHandle">PNS Handle</th>
          <th data-sort="expirationTime">Expires</th>
          <th class="col-actions">Actions</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="load-more"><button id="loadMore" class="secondary" hidden>Load more</button></div>
</section>

<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
