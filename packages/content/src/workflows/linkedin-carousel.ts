// SPDX-License-Identifier: AGPL-3.0-or-later
// Shipped workflow: LinkedIn carousel. Concept → Assets → Copy → Review, each a user-gated step.
// The base prompts here are the stage's shipped system prompt; the brand kit + card context layer in
// at runtime (see composeStagePrompt). Grow the library by adding more of these + a PR.
import type { WorkflowDef } from '../workflow-types.js';

export const linkedinCarousel: WorkflowDef = {
  id: 'linkedin-carousel',
  label: 'LinkedIn carousel',
  appliesTo: { formats: ['carousel'], targets: ['linkedin'] },
  stages: [
    {
      id: 'concept',
      label: 'Concept',
      gate: 'user',
      action: {
        type: 'chat',
        skills: ['LinkedIn Strategy'],
        reads: ['brief'],
        writes: 'concept',
        basePrompt:
          'You are shaping a LinkedIn CAROUSEL concept with the operator. Work iteratively: propose a ' +
          'concept — a sharp hook (a reveal or contrast, not just a story), a through-line, and a slide-by-slide ' +
          'outline — take their feedback, and refine until they are happy. Use the LinkedIn Strategy skill and ' +
          'memory for hook frameworks. Do not write final copy or generate images yet; land the concept only. ' +
          'When they approve, the concept is frozen onto the card.',
      },
    },
    {
      id: 'assets',
      label: 'Assets',
      gate: 'user',
      action: {
        type: 'chat',
        reads: ['concept'],
        writes: 'assets',
        basePrompt:
          'Turn the approved concept into the carousel assets. First draft one image prompt per slide ' +
          '(consistent style, on-brand), show them for approval, then call image_generate for each and link the ' +
          'resulting artifacts to this card. Keep the prompts on the card. Do not write post copy here.',
      },
    },
    {
      id: 'copy',
      label: 'Copy',
      gate: 'user',
      action: {
        type: 'chat',
        reads: ['concept', 'assets'],
        writes: 'copy',
        basePrompt:
          'Write the LinkedIn post copy that ships with this carousel, GROUNDED in the concept and the ' +
          'generated slides on the card — do not invent facts or a different angle. Open with the carousel hook, ' +
          'keep it in the brand voice, end with a clear takeaway. Return the final copy to freeze onto the card.',
      },
    },
    {
      id: 'review',
      label: 'Review',
      gate: 'user',
      action: { type: 'tool', tool: 'noop' },
    },
  ],
};
