// SPDX-License-Identifier: AGPL-3.0-or-later
// Multi-format file parsers for PDF, images (OCR), DOCX, and Excel files.

export interface ParsedContent {
  text: string;
  format: string;
  tables?: Record<string, unknown>[] | undefined;
  sections?: { heading: string; content: string }[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export class ParseError extends Error {}

// Tesseract.js worker singleton for reuse across multiple OCR calls.
let tesseractWorker: any = null;

async function getTesseractWorker() {
  if (!tesseractWorker) {
    const tesseract = await getTesseract();
    const Tesseract = tesseract.default || tesseract;
    tesseractWorker = await Tesseract.createWorker();
  }
  return tesseractWorker;
}

// Clean up Tesseract worker on process exit.
if (typeof process !== 'undefined') {
  process.on('exit', async () => {
    if (tesseractWorker) {
      await tesseractWorker.terminate();
    }
  });
}

// Dynamically load pdf-parse with error handling for missing dependency.
async function getPdfParse() {
  try {
    // @ts-ignore
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    return mod.default || mod;
  } catch {
    throw new ParseError(
      'PDF parsing requires the pdf-parse library. Install with: pnpm add -w pdf-parse',
    );
  }
}

// Parse PDF files: extract text, detect tables and headings.
export async function parsePdf(bytes: Uint8Array): Promise<ParsedContent> {
  const pdfParse = await getPdfParse();
  const pdf = pdfParse.default || pdfParse;

  try {
    const data = await pdf(bytes);
    const text = data.text ?? '';

    // Table detection (heuristic): look for lines with consistent column structure.
    // Heuristic: detect rows with 3+ space/tab-delimited cells AND (contains numbers OR short cells).
    // Limitations: Works best for simple tabular data; may misidentify dense text or miss complex
    // layouts, multi-line headers, or tables without clear delimiters. For robust extraction of
    // complex, unstructured table formats, production use should integrate specialized PDF table
    // extraction libraries (e.g., camelot-py for Python-based pipelines, or pdfplumber for advanced layouts).
    // Current approach is sufficient for most structured PDFs exported from spreadsheets or reports.
    const lines = text.split('\n');
    const tables: Record<string, unknown>[] = [];
    let currentTable: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        if (currentTable.length > 0) {
          tables.push({ rows: currentTable });
          currentTable = [];
        }
      } else {
        const cells = trimmed.split(/\s{2,}|\t/);
        const hasNumbers = /\d/.test(trimmed);
        const isLikelyTableRow = cells.length >= 3 && (hasNumbers || cells.some((c: string) => c.length < 20));
        if (isLikelyTableRow) {
          currentTable.push(trimmed);
        }
      }
    }
    if (currentTable.length > 0) {
      tables.push({ rows: currentTable });
    }

    // Heading detection (heuristic): lines that are all-caps OR short (<80 chars), capitalized lines.
    // Limitations: Works best for standard document styles; may false-positive on short capitalized
    // phrases, miss headings with irregular capitalization (Title Case vs lowercase subtitles), or
    // miss hierarchical structure (h1 vs h2). For document analysis requiring precise heading hierarchy,
    // consider NLP-based approaches (spaCy, NLTK) or PDF libraries with structural awareness (pdfplumber,
    // PDFMiner). Current approach is suitable for extracting top-level content sections from most PDFs.
    const sections: { heading: string; content: string }[] = [];
    let currentSection = { heading: '', content: '' };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const isAllCaps = trimmed === trimmed.toUpperCase() && trimmed.length > 1;
        const isShortCapsLine = trimmed.length < 80 && /[A-Z]/.test(trimmed) && trimmed.length > 2;
        const isLikelyHeading = isAllCaps || (isShortCapsLine && /^[A-Z]/.test(trimmed));

        if (isLikelyHeading) {
          if (currentSection.heading && currentSection.content) {
            sections.push(currentSection);
          }
          currentSection = { heading: trimmed, content: '' };
        } else if (currentSection.heading) {
          currentSection.content += trimmed + ' ';
        }
      }
    }
    if (currentSection.heading && currentSection.content) {
      sections.push(currentSection);
    }

    return {
      text,
      format: 'pdf',
      ...(tables.length > 0 && { tables }),
      ...(sections.length > 0 && { sections }),
      metadata: {
        pages: data.numpages ?? 0,
        version: data.version,
      },
    };
  } catch (exc) {
    throw new ParseError(
      `PDF parsing failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

// Dynamically load Tesseract.js for OCR with error handling.
async function getTesseract() {
  try {
    // @ts-ignore
    return await import('tesseract.js');
  } catch {
    throw new ParseError(
      'OCR is not available on this node. tesseract.js is an optional dependency (a heavy WASM ' +
        'engine) — installed on cloud nodes but skipped on lean nodes like the Pi (--no-optional). ' +
        'Run this on a node that installs optional deps, or `pnpm add tesseract.js` here. ' +
        'PDF/DOCX/Excel parsing still works without it.',
    );
  }
}

// Parse images with OCR: extract visible text.
export async function parseImageOcr(bytes: Uint8Array): Promise<ParsedContent> {
  try {
    // Reuse Tesseract worker across multiple calls instead of creating/terminating per call
    const worker = await getTesseractWorker();

    // Convert Uint8Array to Buffer then to Blob for broader Tesseract.js compatibility
    // (handles both Node.js and browser environments properly)
    const buffer = Buffer.from(bytes);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const result = await worker.recognize(blob);

    const text = result.data?.text ?? '';
    const confidence = result.data?.confidence ?? 0;

    return {
      text,
      format: 'ocr',
      metadata: { confidence, language: 'eng' },
    };
  } catch (exc) {
    throw new ParseError(
      `OCR processing failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

// Dynamically load mammoth for DOCX parsing.
async function getMammoth() {
  try {
    // @ts-ignore
    return await import('mammoth');
  } catch {
    throw new ParseError(
      'DOCX parsing requires the mammoth library. Install with: pnpm add -w mammoth',
    );
  }
}

// Extract text from HTML by stripping tags. TRUSTED INPUT ONLY.
// ⚠️ SECURITY: This function is unsafe for untrusted or user-supplied HTML. It implements a
// custom state machine for tag removal without sanitization. Use ONLY for trusted sources like
// mammoth.js DOCX conversions. For any untrusted input, use a battle-tested library (dompurify, xss).
// Trusted usage: mammoth.js outputs well-formed HTML with no script injection risk.
function stripTrustedHtmlTags(html: string): string {
  let text = '';
  let inTag = false;
  let inComment = false;

  for (let i = 0; i < html.length; i++) {
    const char = html[i];
    const nextChars = html.substring(i, Math.min(i + 4, html.length));

    // Check for comment start
    if (!inTag && nextChars === '<!--') {
      inComment = true;
      i += 3;
      continue;
    }

    // Check for comment end
    if (inComment && nextChars === '-->') {
      inComment = false;
      i += 2;
      continue;
    }

    // Skip if inside comment
    if (inComment) {
      continue;
    }

    // Handle tag boundaries
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
      text += '\n';
    } else if (!inTag) {
      text += char;
    }
  }

  return text
    .replace(/\n\n+/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Parse DOCX files: extract text and detect structure.
export async function parseDocx(bytes: Uint8Array): Promise<ParsedContent> {
  const mammoth = await getMammoth();

  try {
    const buffer = Buffer.from(bytes);
    const result = await mammoth.convertToHtml({ buffer });
    const html = result.value ?? '';
    const messages = result.messages ?? [];

    // Extract headings from HTML before stripping tags
    const headings = Array.from(html.matchAll(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/gi)).map(
      (m) => m[1]?.trim() ?? '',
    );

    // Strip HTML tags using robust state machine approach (mammoth.js output is trusted)
    const text = stripTrustedHtmlTags(html);

    return {
      text,
      format: 'docx',
      ...(headings.length > 0 && { sections: headings.map((h) => ({ heading: h, content: '' })) }),
      metadata: { warnings: messages.length },
    };
  } catch (exc) {
    throw new ParseError(
      `DOCX parsing failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

// Dynamically load xlsx for Excel parsing.
async function getXlsx() {
  try {
    // @ts-ignore
    return await import('xlsx');
  } catch {
    throw new ParseError(
      'Excel parsing requires the xlsx library. Install with: pnpm add -w xlsx',
    );
  }
}

// Parse Excel files: extract sheets as JSON.
// By default creates a summary to avoid exceeding text limits. Use fullText=true to include
// all cell values (may exceed MAX_TEXT for large spreadsheets; structured data in tables is always included).
export async function parseExcel(bytes: Uint8Array, fullText?: boolean): Promise<ParsedContent> {
  const XLSX = await getXlsx();

  try {
    const workbook = XLSX.read(bytes, { type: 'array' });
    const sheets: Record<string, unknown>[] = [];
    let allText = '';

    for (const sheet of workbook.SheetNames) {
      const ws = workbook.Sheets[sheet];
      if (!ws) continue;
      const data = XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[];
      sheets.push({ sheet, rows: data });

      if (fullText) {
        // Include all cell values for full-text analysis (may be large)
        allText += `\n# ${sheet}\n`;
        for (const row of data) {
          allText += JSON.stringify(row) + '\n';
        }
      } else {
        // Create a summary: sheet name + row/column count (preserves structure without huge text)
        const colCount = data.length > 0 ? Object.keys(data[0]!).length : 0;
        allText += `\n# ${sheet}\n${data.length} rows, ${colCount} columns\n`;
      }
    }

    return {
      text: allText,
      format: 'excel',
      ...(sheets.length > 0 && { tables: sheets }),
      metadata: { sheetCount: workbook.SheetNames.length, fullTextIncluded: fullText ?? false },
    };
  } catch (exc) {
    throw new ParseError(
      `Excel parsing failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
}

// Detect format from MIME type, returning the parser function to use.
export function detectFormatParser(
  mimeType: string,
  requestedFormat?: string,
): ((bytes: Uint8Array) => Promise<ParsedContent>) | null {
  // Explicit format request takes precedence.
  if (requestedFormat) {
    switch (requestedFormat.toLowerCase()) {
      case 'pdf':
        return parsePdf;
      case 'ocr':
        return parseImageOcr;
      case 'docx':
        return parseDocx;
      case 'excel':
      case 'xlsx':
        return parseExcel;
      default:
        return null;
    }
  }

  // Auto-detect from MIME type.
  const base = mimeType.split(';', 1)[0]!.trim().toLowerCase();

  if (base === 'application/pdf') {
    return parsePdf;
  }

  if (base.startsWith('image/')) {
    return parseImageOcr;
  }

  if (
    base === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    base === 'application/msword'
  ) {
    return parseDocx;
  }

  if (
    base === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    base === 'application/vnd.ms-excel'
  ) {
    return parseExcel;
  }

  return null;
}
