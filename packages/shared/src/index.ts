import type { DefinePluginPackageSpec } from "@caido/sdk-shared";

export type Result<T> =
  { kind: "Ok"; value: T } | { kind: "Error"; error: string };

export type TransportState =
  "idle" | "starting" | "running" | "stopping" | "error" | "unsupported";

export type BrowserMode = "docker-managed" | "external-cdp";
export type CookieMode = "shared" | "isolated" | "isolated-cloned";
export type BrowserState =
  "unknown" | "connected" | "disconnected" | "unavailable";

export type TransportStatus = {
  state: TransportState;
  version: string;
  platform: string;
  browser: BrowserState;
  port?: number;
  error?: string;
  routingError?: string;
};

export type Settings = {
  enabled: boolean;
  autoStart: boolean;
  browserMode: BrowserMode;
  agentHost: string;
  agentPort: number;
  agentToken: string;
  cookieMode: CookieMode;
  cdpHost: string;
  cdpPort: number;
  maximumUploadMiB: number;
};

export type ActivityState = "routed" | "succeeded" | "failed" | "interrupted";

export type ActivityEntry = {
  id: string;
  sequence: number;
  startedAt: number;
  completedAt?: number;
  state: ActivityState;
  method: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  browserMode: BrowserMode;
  statusCode?: number;
  protocol?: string;
  durationMs?: number;
  error?: string;
  warning?: string;
};

export type API = {
  getSettings: () => Result<Settings>;
  updateSettings: (settings: Settings) => Promise<Result<Settings>>;
  getStatus: () => Result<TransportStatus>;
  getActivity: () => Result<ActivityEntry[]>;
  clearActivity: () => Result<boolean>;
  startTransport: () => Promise<Result<TransportStatus>>;
  stopTransport: () => Promise<Result<TransportStatus>>;
};

export type Events = {
  "transport:status": (status: TransportStatus) => void;
  "settings:updated": (settings: Settings) => void;
  "activity:updated": (entry: ActivityEntry) => void;
  "activity:cleared": () => void;
};

export type Spec = DefinePluginPackageSpec<{
  manifestId: "mimikyu";
  api: API;
  events: Events;
}>;
