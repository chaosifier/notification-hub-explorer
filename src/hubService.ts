import {
  NotificationHubsClient,
  RestError,
  createAdmNotification,
  createAppleNotification,
  createBaiduNotification,
  createBrowserNotification,
  createFcmLegacyNotification,
  createFcmV1Notification,
  createTemplateNotification,
  createWindowsBadgeNotification,
  createWindowsRawNotification,
  createWindowsTileNotification,
  createWindowsToastNotification,
  createXiaomiNotification,
  isRestError,
  type Notification,
  type NotificationHubsMessageResponse,
  type RegistrationDescription,
} from "@azure/notification-hubs";
import { createClientContext, type NotificationHubsClientContext } from "@azure/notification-hubs/api";
import { createPipelineRequest } from "@azure/core-rest-pipeline";
import { parseXML } from "@azure/core-xml";

export type SendPlatform =
  | "apple"
  | "fcmv1"
  | "gcm"
  | "windows-toast"
  | "windows-tile"
  | "windows-badge"
  | "windows-raw"
  | "template"
  | "adm"
  | "baidu"
  | "xiaomi"
  | "browser";

export const PLATFORM_LABELS: Record<SendPlatform, string> = {
  apple: "Apple (APNS)",
  fcmv1: "Firebase (FCM v1)",
  gcm: "Firebase Legacy (GCM/FCM)",
  "windows-toast": "Windows (WNS) - Toast",
  "windows-tile": "Windows (WNS) - Tile",
  "windows-badge": "Windows (WNS) - Badge",
  "windows-raw": "Windows (WNS) - Raw",
  template: "Template (custom properties)",
  adm: "Amazon (ADM)",
  baidu: "Baidu",
  xiaomi: "Xiaomi",
  browser: "Browser (Web Push)",
};

export const DEFAULT_PAYLOADS: Record<SendPlatform, string> = {
  apple: JSON.stringify({ aps: { alert: { title: "Test", body: "Hello from Notification Hub Explorer" }, sound: "default" } }, null, 2),
  fcmv1: JSON.stringify({ message: { notification: { title: "Test", body: "Hello from Notification Hub Explorer" }, data: { key: "value" } } }, null, 2),
  gcm: JSON.stringify({ notification: { title: "Test", body: "Hello from Notification Hub Explorer" }, data: { key: "value" } }, null, 2),
  "windows-toast":
    '<toast>\n  <visual>\n    <binding template="ToastGeneric">\n      <text>Test</text>\n      <text>Hello from Notification Hub Explorer</text>\n    </binding>\n  </visual>\n</toast>',
  "windows-tile":
    '<tile>\n  <visual>\n    <binding template="TileMedium">\n      <text hint-style="subtitle">Test</text>\n      <text hint-style="captionSubtle">Hello from Notification Hub Explorer</text>\n    </binding>\n  </visual>\n</tile>',
  "windows-badge": '<badge value="1"/>',
  "windows-raw": "Hello from Notification Hub Explorer",
  template: JSON.stringify({ title: "Test", message: "Hello from Notification Hub Explorer" }, null, 2),
  adm: JSON.stringify({ data: { message: "Hello from Notification Hub Explorer" } }, null, 2),
  baidu: JSON.stringify({ title: "Test", description: "Hello from Notification Hub Explorer" }, null, 2),
  xiaomi: JSON.stringify({ title: "Test", description: "Hello from Notification Hub Explorer" }, null, 2),
  browser: JSON.stringify({ title: "Test", body: "Hello from Notification Hub Explorer" }, null, 2),
};

export type SendTarget = "broadcast" | "tag" | "device";

export interface SendRequest {
  platform: SendPlatform;
  target: SendTarget;
  tagExpression?: string;
  deviceHandle?: string;
  body: string;
  headers?: Record<string, string>;
  testSend: boolean;
}

export interface RegistrationRow {
  registrationId: string;
  kind: string;
  isTemplate: boolean;
  pnsHandle: string;
  tags: string[];
  expirationTime?: string;
  etag?: string;
  templateName?: string;
  bodyTemplate?: string;
}

export interface RegistrationPage {
  rows: RegistrationRow[];
  hasMore: boolean;
}

/** The PNS handle field differs per registration kind. */
export function getPnsHandle(reg: RegistrationDescription): string {
  const r = reg as unknown as Record<string, unknown>;
  for (const key of [
    "deviceToken",
    "fcmV1RegistrationId",
    "gcmRegistrationId",
    "channelUri",
    "admRegistrationId",
    "baiduChannelId",
    "xiaomiRegistrationId",
    "endpoint",
  ]) {
    if (typeof r[key] === "string" && r[key]) {
      return r[key] as string;
    }
  }
  return "";
}

export function toRow(reg: RegistrationDescription): RegistrationRow {
  const r = reg as unknown as Record<string, unknown>;
  return {
    registrationId: reg.registrationId ?? "",
    kind: reg.kind,
    isTemplate: reg.kind.endsWith("Template"),
    pnsHandle: getPnsHandle(reg),
    tags: reg.tags ?? [],
    expirationTime: reg.expirationTime ? new Date(reg.expirationTime).toISOString() : undefined,
    etag: reg.etag,
    templateName: typeof r.templateName === "string" ? r.templateName : undefined,
    bodyTemplate: typeof r.bodyTemplate === "string" ? r.bodyTemplate : undefined,
  };
}

/** Maps a registration kind to the most appropriate send platform for a direct send. */
export function platformForKind(kind: string): SendPlatform {
  const base = kind.replace(/Template$/, "").toLowerCase();
  switch (base) {
    case "apple":
      return "apple";
    case "fcmv1":
      return "fcmv1";
    case "gcm":
      return "gcm";
    case "windows":
    case "mpns":
      return "windows-toast";
    case "adm":
      return "adm";
    case "baidu":
      return "baidu";
    case "xiaomi":
      return "xiaomi";
    case "browser":
      return "browser";
    default:
      return "template";
  }
}

export function buildNotification(platform: SendPlatform, body: string, headers?: Record<string, string>): Notification {
  const h = headers && Object.keys(headers).length ? headers : undefined;
  switch (platform) {
    case "apple":
      return createAppleNotification({ body, headers: h });
    case "fcmv1":
      return createFcmV1Notification({ body, headers: h });
    case "gcm":
      return createFcmLegacyNotification({ body, headers: h });
    case "windows-toast":
      return createWindowsToastNotification({ body, headers: h });
    case "windows-tile":
      return createWindowsTileNotification({ body, headers: h });
    case "windows-badge":
      return createWindowsBadgeNotification({ body, headers: h });
    case "windows-raw":
      return createWindowsRawNotification({ body, headers: h });
    case "template":
      return createTemplateNotification({ body, headers: h });
    case "adm":
      return createAdmNotification({ body, headers: h });
    case "baidu":
      return createBaiduNotification({ body, headers: h });
    case "xiaomi":
      return createXiaomiNotification({ body, headers: h });
    case "browser":
      return createBrowserNotification({ body, headers: h });
  }
}

export function describeError(err: unknown): string {
  if (isRestError(err)) {
    const status = err.statusCode ? `HTTP ${err.statusCode}: ` : "";
    let detail = err.message;
    const bodyText = (err.response as { bodyAsText?: string } | undefined)?.bodyAsText;
    if (bodyText) {
      const m = /<Detail>([\s\S]*?)<\/Detail>/i.exec(bodyText);
      if (m) {
        detail = m[1];
      }
    }
    if (err.statusCode === 401) {
      detail += " — check the connection string's key and its Listen/Send/Manage rights.";
    }
    return status + detail;
  }
  return err instanceof Error ? err.message : String(err);
}

type PageIterator = AsyncIterator<RegistrationDescription[]>;

/** Wraps the Notification Hubs SDK with paging state and send helpers. */
export class HubService {
  readonly client: NotificationHubsClient;
  private readonly clientContext: NotificationHubsClientContext;
  private pager?: PageIterator;
  private pagerDone = true;
  private pageSize = 100;

  constructor(connectionString: string, hubName: string) {
    this.client = new NotificationHubsClient(connectionString, hubName);
    this.clientContext = createClientContext(connectionString, hubName);
  }

  async firstPage(tag: string | undefined, pageSize: number): Promise<RegistrationPage> {
    this.pageSize = pageSize;
    const options = { top: pageSize };
    const iterable = tag
      ? this.client.listRegistrationsByTag(tag, options)
      : this.client.listRegistrations(options);
    this.pager = iterable.byPage({ maxPageSize: pageSize })[Symbol.asyncIterator]();
    this.pagerDone = false;
    return this.nextPage();
  }

  async nextPage(): Promise<RegistrationPage> {
    if (!this.pager || this.pagerDone) {
      return { rows: [], hasMore: false };
    }
    const result = await this.pager.next();
    if (result.done) {
      this.pagerDone = true;
      return { rows: [], hasMore: false };
    }
    const rows = (result.value ?? []).map(toRow);
    // Pages are requested with $top = pageSize, so a short page means there's nothing left.
    if (rows.length < this.pageSize) {
      this.pagerDone = true;
    }
    return { rows, hasMore: !this.pagerDone };
  }

  async getRegistration(id: string): Promise<RegistrationDescription> {
    return this.client.getRegistration(id);
  }

  async deleteRegistration(id: string): Promise<void> {
    await this.client.deleteRegistration(id);
  }

  async updateTags(id: string, tags: string[]): Promise<RegistrationRow> {
    const reg = await this.client.getRegistration(id);
    reg.tags = tags;
    const updated = await this.client.updateRegistration(reg);
    return toRow(updated);
  }

  async send(req: SendRequest): Promise<NotificationHubsMessageResponse> {
    const notification = buildNotification(req.platform, req.body, req.headers);
    switch (req.target) {
      case "broadcast":
        return this.sendBroadcast(notification, req.testSend);
      case "tag":
        if (!req.tagExpression?.trim()) {
          throw new Error("A tag expression is required.");
        }
        return this.client.sendNotification(notification, {
          tagExpression: req.tagExpression.trim(),
          enableTestSend: req.testSend,
        });
      case "device":
        if (!req.deviceHandle?.trim()) {
          throw new Error("A device handle (PNS handle) is required.");
        }
        return this.client.sendNotification(notification, { deviceHandle: req.deviceHandle.trim() });
    }
  }

  private async sendBroadcast(notification: Notification, testSend: boolean): Promise<NotificationHubsMessageResponse> {
    const endpoint = this.clientContext.requestUrl();
    endpoint.pathname += "/messages/";
    if (testSend) {
      endpoint.searchParams.set("test", "true");
    }

    const headers = await this.clientContext.createHeaders(
      "sendNotification",
      notification.headers as Record<string, string> | undefined,
    );
    headers.set("ServiceBusNotification-Format", notification.platform);
    headers.set("Content-Type", notification.contentType);

    const request = createPipelineRequest({ url: endpoint.toString(), method: "POST", headers });
    request.body = notification.body;
    const response = await this.clientContext.sendRequest(request);
    if (response.status !== 201) {
      throw new RestError(`operation failed with status ${response.status}`, {
        statusCode: response.status,
        response,
      });
    }

    const location = response.headers.get("Location") ?? undefined;
    const notificationId = location?.match(/\/messages\/([^/?]+)/)?.[1];
    const result = {
      correlationId: response.headers.get("x-ms-correlation-request-id") ?? undefined,
      trackingId: response.headers.get("TrackingId") ?? undefined,
      location,
      notificationId,
    };

    if (!testSend || !response.bodyAsText) {
      return { ...result, successCount: 0, failureCount: 0, results: [], state: "Enqueued" };
    }

    const outcome = (await parseXML(response.bodyAsText, { includeRoot: true })).NotificationOutcome;
    const resultNode = outcome.Results?.RegistrationResult;
    const registrationResults = resultNode === undefined ? [] : Array.isArray(resultNode) ? resultNode : [resultNode];
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    return {
      ...result,
      successCount: Number(outcome.Success),
      failureCount: Number(outcome.Failure),
      results: registrationResults.map((item: Record<string, unknown>) => ({
        applicationPlatform: text(item.ApplicationPlatform),
        registrationId: text(item.RegistrationId),
        outcome: text(item.Outcome),
        pnsHandle: text(item.PnsHandle),
      })),
      state: "DetailedStateAvailable",
    };
  }
}
