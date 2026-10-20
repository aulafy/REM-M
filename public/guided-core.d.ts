export type Lang = 'es' | 'en';
export interface StepFacts { aiOk: boolean; project: unknown; understood: boolean; draftsWithBody: number; approvedCount: number; publishedOrScheduled: boolean; copied: boolean; monthPlanStarted: boolean; monthSkipped: boolean; jobRunning?: boolean }
export interface Step { id: string; status: 'done' | 'current' | 'upcoming'; optional: boolean }
export interface StepPlan { steps: Step[]; doneCount: number; total: number; current: string | null }
export interface FriendlyError { message: string; fix: 'retry' | 'ai' | 'none'; details: string }
export interface Provider { name: string; baseUrl: string; model: string; site: string; section: string; prefix: string }
export const STEP_IDS: string[];
export const OPTIONAL_STEPS: Set<string>;
export const BANNED_IN_SIMPLE: string[];
export const ENGINE_COPY_KEYS: Set<string>;
export const T: Record<Lang, Record<string, string>>;
export const PROVIDERS: Record<string, Provider>;
export function computeSteps(facts: StepFacts): StepPlan;
export function charStatus(count: number, limit: number | null | undefined, lang?: Lang): { ok: boolean; text: string };
export function formatDuration(seconds: number, lang?: Lang): string;
export function friendlyError(raw: unknown, lang?: Lang): FriendlyError;
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string;
export function channelKey(channel: string): string;
