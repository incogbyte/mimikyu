import type { SDK } from "caido:plugin";
import type {
  ActivityEntry,
  Result,
  Settings,
  Spec,
  TransportStatus,
} from "shared";

import { type ActivityCompleteEvent, ActivityStore } from "./activity";
import { type AgentRequestEvent, AgentService } from "./agent";
import { RejectionService } from "./rejection";
import { refreshUpstreamRules } from "./routing";
import { SettingsStore } from "./settings";
import type { BackendSDK } from "./types";
import { createUpstreamHandler } from "./upstream";

const settingsStore = new SettingsStore();
let agent: AgentService | undefined;
let activity: ActivityStore | undefined;
let rejection: RejectionService | undefined;

function getSettings(_sdk: BackendSDK): Result<Settings> {
  try {
    return { kind: "Ok", value: settingsStore.get() };
  } catch (error) {
    return { kind: "Error", error: String(error) };
  }
}

async function updateSettings(
  sdk: BackendSDK,
  settings: Settings,
): Promise<Result<Settings>> {
  if (typeof settings !== "object" || settings === null) {
    return { kind: "Error", error: "Settings must be an object" };
  }
  if (
    settings.browserMode !== "docker-managed" &&
    settings.browserMode !== "external-cdp"
  ) {
    return { kind: "Error", error: "Invalid browser mode" };
  }
  if (
    typeof settings.agentHost !== "string" ||
    settings.agentHost.length === 0 ||
    !Number.isInteger(settings.agentPort) ||
    settings.agentPort < 0 ||
    settings.agentPort > 65535 ||
    typeof settings.cdpHost !== "string" ||
    settings.cdpHost.length === 0 ||
    !Number.isInteger(settings.cdpPort) ||
    settings.cdpPort < 1 ||
    settings.cdpPort > 65535 ||
    !Number.isSafeInteger(settings.maximumUploadMiB) ||
    settings.maximumUploadMiB < 0 ||
    settings.maximumUploadMiB > 1_048_576
  ) {
    return { kind: "Error", error: "Invalid agent, CDP, or upload settings" };
  }

  try {
    const saved = await settingsStore.save(sdk, settings);
    if (saved.enabled && saved.autoStart && agent !== undefined) {
      const started = await agent.start(saved);
      if (started.kind === "Error") {
        return {
          kind: "Error",
          error: `Settings were saved, but the browser agent could not start: ${started.error}`,
        };
      }
    }
    return { kind: "Ok", value: saved };
  } catch (error) {
    return { kind: "Error", error: String(error) };
  }
}

function getStatus(_sdk: BackendSDK): Result<TransportStatus> {
  if (agent === undefined)
    return { kind: "Error", error: "Agent is not initialized" };
  return { kind: "Ok", value: agent.getStatus() };
}

function getActivity(_sdk: BackendSDK): Result<ActivityEntry[]> {
  if (activity === undefined)
    return { kind: "Error", error: "Activity store is not initialized" };
  return { kind: "Ok", value: activity.list() };
}

function clearActivity(_sdk: BackendSDK): Result<boolean> {
  if (activity === undefined)
    return { kind: "Error", error: "Activity store is not initialized" };
  activity.clear();
  return { kind: "Ok", value: true };
}

async function startAgent(_sdk: BackendSDK): Promise<Result<TransportStatus>> {
  if (agent === undefined)
    return { kind: "Error", error: "Agent is not initialized" };
  try {
    return agent.start(settingsStore.get());
  } catch (error) {
    return { kind: "Error", error: String(error) };
  }
}

async function stopAgent(_sdk: BackendSDK): Promise<Result<TransportStatus>> {
  if (agent === undefined)
    return { kind: "Error", error: "Agent is not initialized" };
  return agent.stop();
}

function toActivityEvent(event: AgentRequestEvent): ActivityCompleteEvent {
  if (event.outcome === "succeeded") {
    return {
      id: event.trace,
      outcome: "succeeded",
      statusCode: event.statusCode ?? 200,
      protocol: "browser",
      durationMs: event.durationMs,
    };
  }
  return {
    id: event.trace,
    outcome: "failed",
    error: event.error ?? "Browser agent request failed",
    durationMs: event.durationMs,
  };
}

export async function init(sdk: SDK<Spec>): Promise<void> {
  const backendSDK: BackendSDK = sdk;
  await rejection?.close();
  const activityStore = new ActivityStore(backendSDK);
  activity = activityStore;
  agent = new AgentService(
    backendSDK,
    (event) => activityStore.complete(toActivityEvent(event)),
    (reason) => activityStore.interruptPending(reason),
  );
  rejection = new RejectionService(backendSDK, () =>
    agent?.getConnectionDetails(),
  );

  sdk.api.register("getSettings", getSettings);
  sdk.api.register("updateSettings", updateSettings);
  sdk.api.register("getStatus", getStatus);
  sdk.api.register("getActivity", getActivity);
  sdk.api.register("clearActivity", clearActivity);
  sdk.api.register("startTransport", startAgent);
  sdk.api.register("stopTransport", stopAgent);

  sdk.events.onUpstream(
    createUpstreamHandler(
      agent,
      () => settingsStore.get(),
      activityStore,
      rejection,
    ),
  );
  sdk.events.onInterceptResponse((_sdk, request, response) => {
    activityStore.completeFromResponse(request, response);
  });

  try {
    await rejection.start();
  } catch {
    agent.setRoutingError(
      "Private rejection listener could not start; safe rejection is unavailable",
    );
    sdk.console.error("[Mimikyu] Private rejection listener could not start");
  }

  try {
    await refreshUpstreamRules(backendSDK);
  } catch (error) {
    const message = `Upstream rule refresh failed; re-save the rule in Caido Network settings: ${String(error)}`;
    agent.setRoutingError(message);
    sdk.console.error(`[Mimikyu] ${message}`);
  }

  try {
    await settingsStore.load(backendSDK);
  } catch (error) {
    sdk.console.error(`[Mimikyu] ${String(error)}`);
    return;
  }

  const settings = settingsStore.get();
  if (settings.enabled && settings.autoStart) {
    const result = await agent.start(settings);
    if (result.kind === "Error") sdk.console.error(`[Mimikyu] ${result.error}`);
  }
}
