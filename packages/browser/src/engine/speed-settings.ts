import type { EngineSettings } from './task.js';

/** The speed switches (plans, value pointers, the early extract), read the same way by the browser and app paths. */
export interface SpeedConfiguration {
  /** Longest plan one decision may return (1-6, default 6; 1 = one action per decision). */
  readonly planLength?: number;
  /** Read flat want.data values from the lines the confirming decision points at (default true). */
  readonly valuePointers?: boolean;
  /** Start the want.data extract beside a decision that is likely the last (default true). */
  readonly speculativeExtract?: boolean;
  /** Keep what a page shows of the goal when the task moves on to another page (default true). */
  readonly pageNotes?: boolean;
}

export function speedSettings(configuration: SpeedConfiguration): Partial<EngineSettings> {
  return {
    ...(typeof configuration.planLength === 'number' && Number.isFinite(configuration.planLength)
      ? { planLength: Math.min(6, Math.max(1, Math.floor(configuration.planLength))) }
      : {}),
    ...(typeof configuration.valuePointers === 'boolean'
      ? { valuePointers: configuration.valuePointers }
      : {}),
    ...(typeof configuration.speculativeExtract === 'boolean'
      ? { speculativeExtract: configuration.speculativeExtract }
      : {}),
    ...(typeof configuration.pageNotes === 'boolean' ? { pageNotes: configuration.pageNotes } : {}),
  };
}
