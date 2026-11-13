import { randomBytes } from "crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "fs/promises";
import path from "path";

import type { BrowserMode, Settings } from "shared";

import { SerialQueue } from "./serial";
import type { BackendSDK } from "./types";

const SETTINGS_FILE = "settings.json";

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  autoStart: true,
  browserMode: "docker-managed",
  agentHost: "127.0.0.1",
  agentPort: 38427,
  agentToken: "",
  cookieMode: "shared",
  cdpHost: "127.0.0.1",
  cdpPort: 9222,
  maximumUploadMiB: 8,
};

export class SettingsStore {
  private settings: Settings | undefined;
  private readonly operations = new SerialQueue();
  private loadError = "Settings have not been loaded";

  public get(): Settings {
    if (this.settings === undefined) throw new Error(this.loadError);
    return { ...this.settings };
  }

  public load(sdk: BackendSDK): Promise<Settings> {
    return this.operations.run(async () => {
      const settingsPath = this.getPath(sdk);
      try {
        await mkdir(path.dirname(settingsPath), { recursive: true });
        const files = await readdir(path.dirname(settingsPath));
        if (files.includes(SETTINGS_FILE)) {
          this.settings = this.parse(
            JSON.parse(await readFile(settingsPath, "utf8")) as unknown,
          );
        } else {
          this.settings = { ...DEFAULT_SETTINGS };
        }
      } catch (error) {
        this.settings = undefined;
        this.loadError = `Failed to load settings: ${String(error)}`;
        throw new Error(this.loadError);
      }
      return this.get();
    });
  }

  public save(sdk: BackendSDK, settings: Settings): Promise<Settings> {
    const snapshot = this.parse(settings);
    return this.operations.run(async () => {
      const settingsPath = this.getPath(sdk);
      const temporaryPath = `${settingsPath}.${randomBytes(16).toString("hex")}.tmp`;
      await mkdir(path.dirname(settingsPath), { recursive: true });
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(snapshot, null, 2));
        } finally {
          await file.close();
        }
        await rename(temporaryPath, settingsPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      this.settings = { ...snapshot };
      sdk.api.send("settings:updated", this.get());
      return this.get();
    });
  }

  private getPath(sdk: BackendSDK): string {
    return path.join(sdk.meta.path(), SETTINGS_FILE);
  }

  private parse(value: unknown): Settings {
    if (typeof value !== "object" || value === null) {
      throw new Error("Settings file must contain an object");
    }
    const candidate = value as Partial<Settings>;
    const browserMode = candidate.browserMode as BrowserMode;
    const agentPort = candidate.agentPort;
    const agentToken = candidate.agentToken ?? DEFAULT_SETTINGS.agentToken;
    const cookieMode = candidate.cookieMode ?? DEFAULT_SETTINGS.cookieMode;
    const cdpPort = candidate.cdpPort;
    const maximumUploadMiB = candidate.maximumUploadMiB;
    if (
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.autoStart !== "boolean" ||
      (browserMode !== "docker-managed" && browserMode !== "external-cdp") ||
      typeof candidate.agentHost !== "string" ||
      candidate.agentHost.length === 0 ||
      typeof agentPort !== "number" ||
      !Number.isInteger(agentPort) ||
      agentPort < 0 ||
      agentPort > 65535 ||
      typeof agentToken !== "string" ||
      agentToken.length > 4096 ||
      (cookieMode !== "shared" &&
        cookieMode !== "isolated" &&
        cookieMode !== "isolated-cloned") ||
      typeof candidate.cdpHost !== "string" ||
      candidate.cdpHost.length === 0 ||
      typeof cdpPort !== "number" ||
      !Number.isInteger(cdpPort) ||
      cdpPort < 1 ||
      cdpPort > 65535 ||
      typeof maximumUploadMiB !== "number" ||
      !Number.isSafeInteger(maximumUploadMiB) ||
      maximumUploadMiB < 0 ||
      maximumUploadMiB > 1_048_576
    ) {
      throw new Error("Settings file contains invalid values");
    }
    return {
      enabled: candidate.enabled,
      autoStart: candidate.autoStart,
      browserMode,
      agentHost: candidate.agentHost,
      agentPort,
      agentToken,
      cookieMode,
      cdpHost: candidate.cdpHost,
      cdpPort,
      maximumUploadMiB,
    };
  }
}

export { DEFAULT_SETTINGS };
