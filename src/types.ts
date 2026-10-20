export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'published';

export interface Project {
  id: string;
  name: string;
  url: string;
  description: string;
  audience: string;
  tone: string;
  language?: 'en' | 'es';
  competitors?: string[];
  strategy: string | null;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HealthHistory {
  id: string;
  projectId: string;
  score: number;
  report: Record<string, unknown>;
  createdAt: string;
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
  scheduledAt: string | null;
  scheduledConnector: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftInput {
  channel: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface GeoCheck {
  question: string;
  answer: string;
  brandAppears: boolean;
  competitors: string[];
}

export interface GeoHistory {
  id: string;
  projectId: string;
  score: number;
  visible: number;
  total: number;
  checks: GeoCheck[];
  createdAt: string;
}

export interface LLM {
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
  stream?(system: string, user: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<string>;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  projectId: string;
  kind: string;
  status: JobStatus;
  progress: number;
  total: number;
  message: string;
  error: string;
  payload: Record<string, unknown>;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunOptions {
  questionCount?: number;
  questions?: string[];
  allowPrivateFetch?: boolean;
  knowledgeData?: string;
  memoryData?: string;
}

export interface KnowledgeDocument { id: string; projectId: string; title: string; source: string; createdAt: string; }
export interface Approval { id: string; agent: string; action: string; params: Record<string, unknown>; summary: string; decision: string; status: string; reason: string; createdAt: string; decidedAt: string | null; }

export interface SearchOpportunity {
  id: string;
  projectId: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  score: number;
  createdAt: string;
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
