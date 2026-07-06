// SPDX-License-Identifier: AGPL-3.0-or-later
// The shipped workflow library — hardcoded config, grown by adding an entry + a PR (like CORE_PLUGINS).
import type { WorkflowDef } from '../workflow-types.js';
import { linkedinCarousel } from './linkedin-carousel.js';

export const WORKFLOWS: WorkflowDef[] = [
  linkedinCarousel,
  // add more shipped workflows here: short-video, newsletter, blog-repurpose, …
];

export function workflowById(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}
