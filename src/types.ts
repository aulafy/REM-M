export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'published';

export interface Project {
  id: string;
  name: string;
  url: string;
  description: string;
  audience: string;
  tone: string;
  strategy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Draft {
  id: string;
  projectId: string;
  agentId: string;
  status: DraftStatus;
  channel: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DraftInput {
  channel: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface LLM {
  complete(system: string, user: string): Promise<string>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export interface PublishResult {
  url?: string;
  path?: string;
  id?: string | number;
  [key: string]: unknown;
}

export interface Connector {
  id: string;
  name: string;
  configured: boolean;
  publish(draft: Draft, project: Project): Promise<PublishResult>;
}
