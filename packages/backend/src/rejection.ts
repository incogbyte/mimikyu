import type { Connection, RequestSpec } from "caido:utils";

import type { BackendSDK } from "./types";

type AgentDetails = { port: number; token: string } | undefined;

// The MVP uses the authenticated agent as a reject-only endpoint. A native
// reject helper can replace this later for a stronger unavailable-agent
// boundary.
export class RejectionService {
  public constructor(
    private readonly sdk: BackendSDK,
    private readonly getAgentDetails: () => AgentDetails,
  ) {}

  public async start(): Promise<void> {}

  public async connect(request: RequestSpec): Promise<{
    connection: Connection;
    request: RequestSpec;
  }> {
    const details = this.getAgentDetails();
    if (details === undefined) {
      throw new Error(
        "Mimikyu agent is unavailable; reject-only relay is unavailable",
      );
    }
    request.setHeader("X-Mimikyu-Token", details.token);
    request.setHeader("X-Mimikyu-Reject", "true");
    return {
      connection: await this.sdk.net.connect(
        `http://127.0.0.1:${details.port}`,
      ),
      request,
    };
  }

  public async close(): Promise<void> {}
}
