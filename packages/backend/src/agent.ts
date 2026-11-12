import { type ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import os from "os";
import path from "path";

import type { Result, Settings, TransportStatus } from "shared";

import { SerialQueue } from "./serial";
import type { BackendSDK } from "./types";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const AGENT_VERSION = "0.1.0";

export type AgentRequestEvent = {
  event: "request";
  trace: string;
  outcome: "succeeded" | "failed";
  statusCode?: number;
  durationMs: number;
  error?: string;
};

type ReadyEvent = {
  event: "ready";
  port: number;
  token: string;
  version: string;
};

export class AgentService {
  private child: ChildProcess | undefined;
  private readonly operations = new SerialQueue();
  private status: TransportStatus;
  private port: number | undefined;
  private token: string | undefined;

  public constructor(
    private readonly sdk: BackendSDK,
    private readonly onRequestEvent: (event: AgentRequestEvent) => void,
    private readonly onExit: (reason: string) => void = () => {},
  ) {
    this.status = {
      state: "idle",
      version: AGENT_VERSION,
      platform: `${os.platform()}/${os.arch()}`,
      browser: "unknown",
    };
  }

  public getStatus(): TransportStatus {
    return { ...this.status };
  }

  public setRoutingError(error: string): void {
    this.setStatus({ routingError: error });
  }

  public getConnectionDetails(): { port: number; token: string } | undefined {
    if (
      this.status.state !== "running" ||
      this.port === undefined ||
      this.token === undefined
    ) {
      return undefined;
    }
    return { port: this.port, token: this.token };
  }

  public start(settings: Settings): Promise<Result<TransportStatus>> {
    return this.operations.run(() => this.startInternal(settings));
  }

  private async startInternal(
    settings: Settings,
  ): Promise<Result<TransportStatus>> {
    if (this.status.state === "running") {
      return { kind: "Ok", value: this.getStatus() };
    }

    this.setStatus({
      state: "starting",
      error: undefined,
      routingError: undefined,
    });

    const runtimeProcess = (
      globalThis as unknown as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process;
    const environment = runtimeProcess?.env ?? {};
    const configuredPort = Number(
      environment.MIMIKYU_AGENT_PORT ?? String(settings.agentPort),
    );
    const configuredToken =
      environment.MIMIKYU_AGENT_TOKEN ?? settings.agentToken;
    if (
      settings.browserMode === "docker-managed" &&
      configuredToken !== undefined &&
      configuredToken !== ""
    ) {
      if (
        !Number.isInteger(configuredPort) ||
        configuredPort < 1 ||
        configuredPort > 65535
      ) {
        return this.fail(
          "MIMIKYU_AGENT_PORT must be a valid TCP port when using an external agent",
        );
      }
      this.port = configuredPort;
      this.token = configuredToken;
      this.setStatus({
        state: "running",
        port: configuredPort,
        browser: "unknown",
      });
      return { kind: "Ok", value: this.getStatus() };
    }
    if (settings.browserMode === "docker-managed") {
      return this.fail(
        "An agent token is required for Docker-managed browser routing",
      );
    }

    const agentPath =
      environment.MIMIKYU_AGENT_PATH ??
      path.join(this.sdk.meta.assetsPath(), "agent", "server.mjs");
    const nodePath = environment.MIMIKYU_AGENT_NODE ?? "node";
    const token = randomBytes(32).toString("hex");
    const child = spawn(nodePath, [agentPath], {
      cwd: path.dirname(agentPath),
      env: {
        ...environment,
        MIMIKYU_AGENT_HOST: "127.0.0.1",
        MIMIKYU_AGENT_PORT: String(
          settings.agentPort === 0 ? 0 : settings.agentPort,
        ),
        MIMIKYU_TOKEN: token,
        CHROME_DEBUGGING_HOST: settings.cdpHost,
        CHROME_DEBUGGING_PORT: String(settings.cdpPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    } as never);
    this.child = child;

    try {
      const ready = await this.waitUntilReady(child);
      if (ready.version !== AGENT_VERSION) {
        throw new Error(
          `Agent version mismatch: expected ${AGENT_VERSION}, received ${ready.version}`,
        );
      }
      this.port = ready.port;
      this.token = ready.token;
      this.setStatus({
        state: "running",
        port: ready.port,
        browser: "unknown",
        error: undefined,
      });
      return { kind: "Ok", value: this.getStatus() };
    } catch (error) {
      await this.terminateChild();
      return this.fail(String(error));
    }
  }

  public stop(): Promise<Result<TransportStatus>> {
    return this.operations.run(async () => {
      this.setStatus({ state: "stopping", error: undefined });
      try {
        await this.terminateChild();
      } catch (error) {
        return this.fail(String(error));
      }
      this.port = undefined;
      this.token = undefined;
      this.setStatus({
        state: "idle",
        port: undefined,
        browser: "unknown",
        error: undefined,
      });
      return { kind: "Ok", value: this.getStatus() };
    });
  }

  private waitUntilReady(child: ChildProcess): Promise<ReadyEvent> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(
        () => settle(() => reject(new Error("Agent startup timed out"))),
        START_TIMEOUT_MS,
      );

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      child.stdout?.on("data", (data) => {
        buffer += String(data);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines)
          this.handleAgentLine(line, resolve, reject, settle);
      });
      child.stderr?.on("data", (data) => {
        const message = String(data).trim();
        if (message !== "")
          this.sdk.console.error(`[Mimikyu agent] ${message}`);
      });
      child.once("error", (error) => settle(() => reject(error)));
      child.once("close", (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.onExit(
          `Mimikyu agent exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}`,
        );
        settle(() => reject(new Error("Mimikyu agent exited during startup")));
      });
    });
  }

  private handleAgentLine(
    line: string,
    resolve: (event: ReadyEvent) => void,
    reject: (error: Error) => void,
    settle: (callback: () => void) => void,
  ): void {
    if (line.trim() === "") return;
    try {
      const event = JSON.parse(line) as {
        event?: string;
        port?: number;
        token?: string;
        version?: string;
        state?: string;
        trace?: string;
        outcome?: "succeeded" | "failed";
        statusCode?: number;
        durationMs?: number;
        error?: string;
      };
      if (
        event.event === "ready" &&
        typeof event.port === "number" &&
        typeof event.token === "string" &&
        typeof event.version === "string"
      ) {
        settle(() => resolve(event as ReadyEvent));
        return;
      }
      if (event.event === "browser") {
        const browser =
          event.state === "connected"
            ? "connected"
            : event.state === "disconnected"
              ? "disconnected"
              : "unavailable";
        this.setStatus({ browser });
        return;
      }
      if (
        event.event === "request" &&
        typeof event.trace === "string" &&
        (event.outcome === "succeeded" || event.outcome === "failed")
      ) {
        this.onRequestEvent(event as AgentRequestEvent);
      }
    } catch {
      this.sdk.console.log(`[Mimikyu agent] ${line}`);
    }
    void reject;
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    await new Promise<void>((resolve, reject) => {
      let forced: Timeout | undefined;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        forced = setTimeout(
          () => reject(new Error("Mimikyu agent did not exit after SIGKILL")),
          STOP_TIMEOUT_MS,
        );
      }, STOP_TIMEOUT_MS);
      child.once("close", () => {
        clearTimeout(timeout);
        if (forced !== undefined) clearTimeout(forced);
        resolve();
      });
      child.kill("SIGTERM");
    });
    if (this.child === child) this.child = undefined;
  }

  private setStatus(update: Partial<TransportStatus>): void {
    this.status = { ...this.status, ...update };
    this.sdk.api.send("transport:status", this.getStatus());
  }

  private fail(error: string): Result<TransportStatus> {
    this.setStatus({
      state: "error",
      port: undefined,
      browser: "unavailable",
      error,
    });
    return { kind: "Error", error };
  }
}
