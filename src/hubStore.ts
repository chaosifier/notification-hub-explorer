import * as vscode from "vscode";

export interface HubInfo {
  id: string;
  hubName: string;
  namespace: string;
}

const HUBS_KEY = "notificationHubs.hubs";
const secretKey = (id: string) => `notificationHubs.connectionString.${id}`;

/** Persists hub metadata in global state and connection strings in SecretStorage. */
export class HubStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): HubInfo[] {
    return this.context.globalState.get<HubInfo[]>(HUBS_KEY, []);
  }

  get(id: string): HubInfo | undefined {
    return this.list().find((h) => h.id === id);
  }

  async getConnectionString(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  async save(hub: HubInfo, connectionString: string): Promise<void> {
    const hubs = this.list().filter((h) => h.id !== hub.id);
    hubs.push(hub);
    hubs.sort((a, b) => `${a.namespace}/${a.hubName}`.localeCompare(`${b.namespace}/${b.hubName}`));
    await this.context.secrets.store(secretKey(hub.id), connectionString);
    await this.context.globalState.update(HUBS_KEY, hubs);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.secrets.delete(secretKey(id));
    await this.context.globalState.update(
      HUBS_KEY,
      this.list().filter((h) => h.id !== id),
    );
    this.changed.fire();
  }
}

export function parseConnectionString(cs: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      result[part.substring(0, idx).trim().toLowerCase()] = part.substring(idx + 1).trim();
    }
  }
  return result;
}

/** Returns an error message if the connection string is invalid, otherwise undefined. */
export function validateConnectionString(cs: string): string | undefined {
  const parts = parseConnectionString(cs);
  if (!parts["endpoint"]) {
    return "Connection string must contain Endpoint=sb://<namespace>.servicebus.windows.net/";
  }
  if (!parts["sharedaccesskeyname"] || !parts["sharedaccesskey"]) {
    return "Connection string must contain SharedAccessKeyName and SharedAccessKey";
  }
  return undefined;
}

export function namespaceFromConnectionString(cs: string): string {
  const endpoint = parseConnectionString(cs)["endpoint"] ?? "";
  const match = /^[a-z]+:\/\/([^./]+)/i.exec(endpoint);
  return match ? match[1] : endpoint;
}
