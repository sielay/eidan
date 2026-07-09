// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage definitions. Keep these in sync with packages/crm/frontend/Crm.tsx DEFAULT_STAGES.
export const DEFAULT_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;
export const TERMINAL_STAGES = new Set(['won', 'lost']);
export type Stage = typeof DEFAULT_STAGES[number];
