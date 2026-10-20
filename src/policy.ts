import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';
import { AppError } from './errors.js';

export const policyModes = ['act', 'ask', 'handoff'] as const;
export type PolicyMode = typeof policyModes[number];
export const actionFloor = new Set(['publish_without_approval', 'delete_data', 'export_data', 'change_settings', 'change_policy', 'connect_channel']);
export const defaultPolicy: Record<string, PolicyMode> = { create_draft: 'act', schedule: 'ask', publish: 'act', save_memory: 'ask', write_briefing: 'act' };

export function normalizePolicy(input: Record<string, unknown> = {}): Record<string, PolicyMode> {
  const output = { ...defaultPolicy };
  for (const [action, mode] of Object.entries(input)) if (action in output && policyModes.includes(mode as PolicyMode)) output[action] = mode as PolicyMode;
  return output;
}

export function beforeAction(options: { actor: string; action: string; policy?: Record<string, unknown>; paused?: boolean }): { decision: 'proceed' | 'confirm' | 'handoff'; reason: string } {
  if (options.actor === 'human') return { decision: 'proceed', reason: 'Human initiated action' };
  if (actionFloor.has(options.action)) return { decision: 'handoff', reason: 'Blocked by the hard system floor' };
  if (!(options.action in defaultPolicy)) return { decision: 'handoff', reason: 'Unknown action is reserved for a human' };
  if (options.paused) return { decision: 'handoff', reason: 'Agents are paused' };
  const mode = normalizePolicy(options.policy)[options.action];
  if (mode === 'act') return { decision: 'proceed', reason: 'Allowed by policy' };
  return mode === 'ask' ? { decision: 'confirm', reason: 'Policy requires approval' } : { decision: 'handoff', reason: 'Policy reserves this action for a human' };
}

export class ActionRunner {
  private readonly logFile: string | null;
  constructor(private store: Store, dataDir?: string) {
    this.logFile = dataDir ? path.join(dataDir, 'activity.jsonl') : null;
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  getPolicy() { try { return normalizePolicy(JSON.parse(this.store.getSettings().actionPolicy || '{}') as Record<string, unknown>); } catch { return normalizePolicy(); } }
  isPaused() { return this.store.getSettings().agentsPaused === '1'; }
  log(entry: Record<string, unknown>) { if (this.logFile) fs.appendFileSync(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); }
  activity(limit = 50): unknown[] {
    if (!this.logFile || !fs.existsSync(this.logFile)) return [];
    return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  setPolicy(input: Record<string, unknown>) { const policy = normalizePolicy(input); this.store.setSettings({ actionPolicy: JSON.stringify(policy) }); this.log({ actor: 'human', action: 'change_policy', decision: 'proceed' }); return policy; }
  stop(paused = true) { this.store.setSettings({ agentsPaused: paused ? '1' : '0' }); if (paused) this.store.clearPendingApprovals(); this.log({ actor: 'human', action: paused ? 'stop_all' : 'resume', decision: 'proceed' }); return paused; }

  async runAction<T>(options: { actor: string; action: string; params?: Record<string, unknown>; summary?: string; apply: () => T | Promise<T> }): Promise<{ decision: string; result?: T; approvalId?: string }> {
    const outcome = beforeAction({ actor: options.actor, action: options.action, policy: this.getPolicy(), paused: this.isPaused() });
    if (outcome.decision === 'proceed') {
      const result = await options.apply(); this.log({ actor: options.actor, action: options.action, decision: 'proceed', reason: outcome.reason, summary: options.summary }); return { decision: 'proceed', result };
    }
    const approval = this.store.createApproval(options.actor, options.action, options.params || {}, options.summary || options.action, outcome.decision, outcome.reason);
    this.log({ actor: options.actor, action: options.action, decision: outcome.decision, reason: outcome.reason, approvalId: approval.id });
    return { decision: outcome.decision, approvalId: approval.id };
  }

  async decide(id: string, approve: boolean, appliers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>) {
    const approval = this.store.getApproval(id);
    if (approval.status !== 'pending') throw new AppError('Approval is no longer pending', 409);
    if (!approve) { this.store.decideApproval(id, 'rejected'); this.log({ actor: 'human', action: approval.action, decision: 'rejected', approvalId: id }); return; }
    if (approval.decision === 'handoff') throw new AppError('This action must be performed directly by a human', 409);
    const apply = appliers[approval.action]; if (!apply) throw new AppError('No executor is available for this approval', 409);
    await apply(approval.params); this.store.decideApproval(id, 'approved'); this.log({ actor: 'human', action: approval.action, decision: 'proceed', approvalId: id });
  }
}
