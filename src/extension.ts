import * as vscode from "vscode";
import { HubPanel, type HubTab } from "./hubPanel";
import { HubStore, namespaceFromConnectionString, validateConnectionString, type HubInfo } from "./hubStore";

class HubItem extends vscode.TreeItem {
  constructor(readonly hub: HubInfo) {
    super(hub.hubName, vscode.TreeItemCollapsibleState.None);
    this.id = hub.id;
    this.description = hub.namespace;
    this.tooltip = `${hub.namespace}.servicebus.windows.net/${hub.hubName}`;
    this.contextValue = "hub";
    this.iconPath = new vscode.ThemeIcon("bell");
    this.command = { command: "notificationHubs.openHub", title: "Open Hub Explorer", arguments: [this] };
  }
}

class HubTreeProvider implements vscode.TreeDataProvider<HubItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: HubStore) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: HubItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HubItem[] {
    return this.store.list().map((h) => new HubItem(h));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new HubStore(context);
  const tree = new HubTreeProvider(store);
  const output = vscode.window.createOutputChannel("Notification Hub Explorer");
  context.subscriptions.push(output, vscode.window.registerTreeDataProvider("notificationHubs", tree));

  /** Resolves the target hub from a tree item, or prompts the user to pick one. */
  async function resolveHub(item?: HubItem): Promise<HubInfo | undefined> {
    if (item?.hub) {
      return item.hub;
    }
    const hubs = store.list();
    if (hubs.length === 0) {
      const add = await vscode.window.showInformationMessage("No notification hubs configured.", "Add Notification Hub");
      return add ? addHub() : undefined;
    }
    if (hubs.length === 1) {
      return hubs[0];
    }
    const pick = await vscode.window.showQuickPick(
      hubs.map((h) => ({ label: h.hubName, description: h.namespace, hub: h })),
      { placeHolder: "Select a notification hub" },
    );
    return pick?.hub;
  }

  async function promptConnection(existing?: HubInfo): Promise<{ connectionString: string; hubName: string } | undefined> {
    const connectionString = await vscode.window.showInputBox({
      title: existing ? `Edit connection for ${existing.hubName} (1/2)` : "Add Notification Hub (1/2)",
      prompt: "Connection string (Azure portal → Notification Hub → Access Policies). Use DefaultFullSharedAccessSignature to manage registrations.",
      placeHolder: "Endpoint=sb://<namespace>.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? validateConnectionString(v.trim()) : "Connection string is required"),
    });
    if (!connectionString) {
      return undefined;
    }
    const hubName = await vscode.window.showInputBox({
      title: existing ? `Edit connection for ${existing.hubName} (2/2)` : "Add Notification Hub (2/2)",
      prompt: "Notification hub name (path)",
      value: existing?.hubName,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Hub name is required"),
    });
    if (!hubName) {
      return undefined;
    }
    return { connectionString: connectionString.trim(), hubName: hubName.trim() };
  }

  async function addHub(): Promise<HubInfo | undefined> {
    const input = await promptConnection();
    if (!input) {
      return undefined;
    }
    const namespace = namespaceFromConnectionString(input.connectionString);
    const id = `${namespace}/${input.hubName}`.toLowerCase();
    if (store.get(id)) {
      const overwrite = await vscode.window.showWarningMessage(
        `${input.hubName} in ${namespace} is already added. Replace its connection string?`,
        { modal: true },
        "Replace",
      );
      if (overwrite !== "Replace") {
        return undefined;
      }
      HubPanel.dispose(id);
    }
    const hub: HubInfo = { id, hubName: input.hubName, namespace };
    await store.save(hub, input.connectionString);
    return hub;
  }

  const open = (tab?: HubTab) => async (item?: HubItem) => {
    const hub = await resolveHub(item);
    if (hub) {
      await HubPanel.show(context, store, output, hub, { tab });
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("notificationHubs.addHub", async () => {
      const hub = await addHub();
      if (hub) {
        await HubPanel.show(context, store, output, hub, { tab: "registrations" });
      }
    }),
    vscode.commands.registerCommand("notificationHubs.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("notificationHubs.openHub", open()),
    vscode.commands.registerCommand("notificationHubs.testSend", open("send")),
    vscode.commands.registerCommand("notificationHubs.searchByTag", async (item?: HubItem) => {
      const hub = await resolveHub(item);
      if (!hub) {
        return;
      }
      const tag = await vscode.window.showInputBox({
        title: `Search registrations in ${hub.hubName}`,
        prompt: "Tag to search for (exact match). Leave empty to list all registrations.",
        placeHolder: "e.g. user:123",
      });
      if (tag !== undefined) {
        await HubPanel.show(context, store, output, hub, { tab: "registrations", tag: tag.trim() });
      }
    }),
    vscode.commands.registerCommand("notificationHubs.editHub", async (item?: HubItem) => {
      const hub = await resolveHub(item);
      if (!hub) {
        return;
      }
      const input = await promptConnection(hub);
      if (!input) {
        return;
      }
      const namespace = namespaceFromConnectionString(input.connectionString);
      const updated: HubInfo = { id: `${namespace}/${input.hubName}`.toLowerCase(), hubName: input.hubName, namespace };
      HubPanel.dispose(hub.id);
      if (updated.id !== hub.id) {
        await store.remove(hub.id);
      }
      await store.save(updated, input.connectionString);
    }),
    vscode.commands.registerCommand("notificationHubs.removeHub", async (item?: HubItem) => {
      const hub = await resolveHub(item);
      if (!hub) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Remove ${hub.hubName} (${hub.namespace}) from the explorer?`,
        { modal: true, detail: "Only the saved connection is removed; the hub in Azure is not affected." },
        "Remove",
      );
      if (answer === "Remove") {
        HubPanel.dispose(hub.id);
        await store.remove(hub.id);
      }
    }),
  );
}

export function deactivate(): void {}
