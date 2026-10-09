import type { WebSocket } from "ws";

export type AgentConnection = {
  agentId: string;
  sessionId: string;
  generation: number;
  capabilities: string[];
  socket: WebSocket;
  messageCount: number;
  channelMessageCount: number;
  rateWindowStartedAt: number;
  processing: Promise<void>;
  closing?: Promise<void>;
};

// The initial registry is intentionally process-local. Keeping the gateway
// behind this interface makes a distributed ownership/routing implementation
// possible without pretending the current deployment is multi-instance safe.
export interface AgentConnectionRegistry {
  get(agentId: string): AgentConnection | undefined;
  set(agentId: string, connection: AgentConnection): void;
  deleteIfCurrent(agentId: string, connection: AgentConnection): boolean;
  values(): AgentConnection[];
}

export class InMemoryAgentConnectionRegistry implements AgentConnectionRegistry {
  private readonly connections = new Map<string, AgentConnection>();

  get(agentId: string) {
    return this.connections.get(agentId);
  }

  set(agentId: string, connection: AgentConnection) {
    this.connections.set(agentId, connection);
  }

  deleteIfCurrent(agentId: string, connection: AgentConnection) {
    if (this.connections.get(agentId) !== connection) return false;
    this.connections.delete(agentId);
    return true;
  }

  values() {
    return [...this.connections.values()];
  }
}
