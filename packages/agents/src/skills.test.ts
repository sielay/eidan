// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'assert';
import { expandSkillReferences, detectSkillReferences, BUILTIN_SKILLS } from './skills/index.js';

// Basic skill reference expansion
const personaWithSkills = `
[skill: Agent Foundation]
[skill: Function Call Hardening]

Your task: review emails and summarize daily changes.
`;

const expanded = expandSkillReferences(personaWithSkills);
assert(expanded.includes('EIDAN Agent Foundation'), 'Should expand Agent Foundation skill');
assert(expanded.includes('Function Call Hardening'), 'Should expand Function Call Hardening skill');
assert(expanded.includes('Your task: review emails'), 'Should preserve non-skill content');

// Detect skill references
const detected = detectSkillReferences(personaWithSkills);
assert(detected.includes('agent-foundation'), 'Should detect agent-foundation skill');
assert(detected.includes('function-call-hardening'), 'Should detect function-call-hardening skill');
assert(detected.length === 2, 'Should detect exactly 2 skills');

// Legacy persona (no skills) should not expand
const legacyPersona = 'You are an agent. Do your task.';
const legacyExpanded = expandSkillReferences(legacyPersona);
assert(legacyExpanded === legacyPersona, 'Should not modify personas without skill references');
const legacyDetected = detectSkillReferences(legacyPersona);
assert(legacyDetected.length === 0, 'Should detect no skills in legacy persona');

// Invalid skill reference should not expand
const invalidPersona = '[skill: Unknown Skill] Do your work.';
const invalidExpanded = expandSkillReferences(invalidPersona);
assert(invalidExpanded === invalidPersona, 'Should not expand unknown skills');

// Case insensitivity
const caseInsensitivePersona = '[skill: AGENT-FOUNDATION] Your task.';
const caseInsensitiveDetected = detectSkillReferences(caseInsensitivePersona);
assert(caseInsensitiveDetected.includes('agent-foundation'), 'Should handle case-insensitive skill names');

// Verify skills have content
const foundationSkill = BUILTIN_SKILLS['agent-foundation'];
const hardeningSkill = BUILTIN_SKILLS['function-call-hardening'];
assert(foundationSkill && foundationSkill.content.length > 500, 'Agent Foundation skill should have substantial content');
assert(hardeningSkill && hardeningSkill.content.length > 500, 'Function Call Hardening skill should have substantial content');

console.log('✅ All skill expansion tests passed');
