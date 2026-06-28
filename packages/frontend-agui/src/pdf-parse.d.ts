// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-parse ships no type declarations; we lazy-import the internal entry (pdf-parse/lib/pdf-parse.js)
// to avoid its index.js test-file side effect. Declared as untyped — server.ts narrows the shape.
declare module 'pdf-parse/lib/pdf-parse.js';
