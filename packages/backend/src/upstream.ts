import type { Connection, RequestSpec, RequestSpecRaw } from "caido:utils";
import type { Settings } from "shared";

import type { ActivityStore } from "./activity";
import type { AgentService } from "./agent";
import type { RejectionService } from "./rejection";
import type { BackendSDK } from "./types";

const INTERNAL_HEADERS = {
  token: "X-Mimikyu-Token",
  scheme: "X-Mimikyu-Scheme",
  host: "X-Mimikyu-Host",
  port: "X-Mimikyu-Port",
  trace: "X-Mimikyu-Trace",
  maxBody: "X-Mimikyu-Max-Body-Bytes",
  cookieMode: "X-Mimikyu-Cookie-Mode",
} as const;

export function createUpstreamHandler(
  agent: AgentService,
  getSettings: () => Settings,
  activity: ActivityStore,
  rejection: RejectionService,
): (
  sdk: BackendSDK,
  request: RequestSpecRaw,
) => Promise<{ connection: Connection; request: RequestSpec } | undefined> {
  return async (sdk, request) => {
    const spec = request.toSpec();
    const reject = async (): Promise<{
      connection: Connection;
      request: RequestSpec;
    }> => rejection.connect(spec);

    let settings: Settings;
    try {
      settings = getSettings();
    } catch {
      return reject();
    }
    if (settings.enabled === false) {
      if (spec.getHeader("X-Mimikyu-Egress") !== undefined) {
        return reject();
      }
      return undefined;
    }
    if (spec.getHeader("X-Mimikyu-Egress") !== undefined) {
      return reject();
    }

    const scheme = request.getTls() ? "https" : "http";
    const host = request.getHost();
    const port = request.getPort();
    const entry = activity.begin({
      host,
      method: spec.getMethod(),
      port,
      browserMode: settings.browserMode,
      scheme,
    });

    const details = agent.getConnectionDetails();
    if (details === undefined) {
      const message =
        "Mimikyu browser agent is unavailable; refusing direct fallback";
      activity.fail(entry.id, message);
      return reject();
    }

    spec.setHeader(INTERNAL_HEADERS.token, details.token);
    spec.setHeader(INTERNAL_HEADERS.scheme, scheme);
    spec.setHeader(INTERNAL_HEADERS.host, host);
    spec.setHeader(INTERNAL_HEADERS.port, String(port));
    spec.setHeader(INTERNAL_HEADERS.trace, entry.id);
    spec.setHeader(
      INTERNAL_HEADERS.maxBody,
      String(settings.maximumUploadMiB * 1024 * 1024),
    );
    spec.setHeader(INTERNAL_HEADERS.cookieMode, settings.cookieMode);

    try {
      const connection = await sdk.net.connect(
        `http://${settings.agentHost}:${details.port}`,
      );
      return { connection, request: spec };
    } catch (error) {
      activity.fail(entry.id, String(error));
      return reject();
    }
  };
}
