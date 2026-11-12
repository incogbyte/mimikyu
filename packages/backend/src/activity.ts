import type { Request, Response } from "caido:utils";
import type { ActivityEntry } from "shared";

import { MAX_ACTIVITY_ENTRIES } from "../../shared/src/activity";

import type { BackendSDK } from "./types";

export type ActivityCompleteEvent = {
  id: string;
  outcome: "succeeded" | "failed";
  statusCode?: number;
  protocol?: string;
  durationMs: number;
  error?: string;
  warning?: string;
};

const MAX_ERROR_LENGTH = 500;

type BeginActivity = Pick<
  ActivityEntry,
  "host" | "method" | "port" | "browserMode" | "scheme"
>;

export class ActivityStore {
  private entries: ActivityEntry[] = [];
  private sequence = 0;

  public constructor(private readonly sdk: BackendSDK) {}

  public list(): ActivityEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  public begin(input: BeginActivity): ActivityEntry {
    this.sequence += 1;
    const entry: ActivityEntry = {
      ...input,
      id: `${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      sequence: this.sequence,
      startedAt: Date.now(),
      state: "routed",
    };

    this.entries.unshift(entry);
    if (this.entries.length > MAX_ACTIVITY_ENTRIES) {
      this.entries.length = MAX_ACTIVITY_ENTRIES;
    }
    this.publish(entry);
    return { ...entry };
  }

  public complete(event: ActivityCompleteEvent): void {
    const entry = this.entries.find((candidate) => candidate.id === event.id);
    if (entry === undefined || entry.state !== "routed") {
      return;
    }

    entry.completedAt = Date.now();
    entry.durationMs = event.durationMs;
    entry.warning = event.warning;
    if (event.outcome === "succeeded") {
      entry.state = "succeeded";
      entry.statusCode = event.statusCode;
      entry.protocol = event.protocol;
      entry.error = undefined;
    } else {
      entry.state = "failed";
      entry.error = this.truncate(
        event.error ?? "Browser agent request failed",
      );
    }
    this.publish(entry);
  }

  public completeFromResponse(request: Request, response: Response): void {
    const trace = request.getHeader("X-Mimikyu-Trace");
    const id = Array.isArray(trace) ? trace[0] : trace;
    const entry =
      id === undefined
        ? this.entries.find(
            (candidate) =>
              candidate.state === "routed" &&
              candidate.method === request.getMethod() &&
              candidate.host === request.getHost() &&
              candidate.port === request.getPort(),
          )
        : this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.state !== "routed") return;

    this.complete({
      id: entry.id,
      outcome: "succeeded",
      statusCode: response.getCode(),
      protocol: "caido",
      durationMs: response.getRoundtripTime(),
    });
  }

  public fail(id: string, error: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.state !== "routed") {
      return;
    }

    entry.state = "failed";
    entry.completedAt = Date.now();
    entry.durationMs = entry.completedAt - entry.startedAt;
    entry.error = this.truncate(error);
    this.publish(entry);
  }

  public clear(): void {
    this.entries = [];
    this.sdk.api.send("activity:cleared");
  }

  public interruptPending(reason: string): void {
    for (const entry of this.entries) {
      if (entry.state !== "routed") continue;
      entry.state = "interrupted";
      entry.completedAt = Date.now();
      entry.durationMs = entry.completedAt - entry.startedAt;
      entry.error = this.truncate(reason);
      this.publish(entry);
    }
  }

  private truncate(error: string): string {
    return error.length > MAX_ERROR_LENGTH
      ? `${error.slice(0, MAX_ERROR_LENGTH - 1)}…`
      : error;
  }

  private publish(entry: ActivityEntry): void {
    this.sdk.api.send("activity:updated", { ...entry });
  }
}
