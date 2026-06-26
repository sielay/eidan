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

    // Simple heuristic: detect lines that look like table rows (multiple numbers/short words)
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
      } else if (trimmed.split(/\s{2,}|\t/).length > 2) {
        currentTable.push(trimmed);
      }
    }
    if (currentTable.length > 0) {
      tables.push({ rows: currentTable });
    }

    // Extract section headings (lines in all caps or followed by content).
    const sections: { heading: string; content: string }[] = [];
    let currentSection = { heading: '', content: '' };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed === trimmed.toUpperCase() && trimmed.length < 100) {
        if (currentSection.heading && currentSection.content) {
          sections.push(currentSection);
        }
        currentSection = { heading: trimmed, content: '' };
      } else if (currentSection.heading) {
        currentSection.content += trimmed + ' ';
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
      'OCR requires the tesseract.js library. Install with: pnpm add -w tesseract.js',
    );
  }
}

// Parse images with OCR: extract visible text.
export async function parseImageOcr(bytes: Uint8Array): Promise<ParsedContent> {
  const tesseract = await getTesseract();
  const Tesseract = tesseract.default || tesseract;

  try {
    const worker = await Tesseract.createWorker();
    // Convert Uint8Array to Buffer for Tesseract.js compatibility
    const buffer = Buffer.from(bytes);
    const result = await worker.recognize(buffer as any);
    await worker.terminate();

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

// Parse DOCX files: extract text and detect structure.
export async function parseDocx(bytes: Uint8Array): Promise<ParsedContent> {
  const mammoth = await getMammoth();

  try {
    const buffer = Buffer.from(bytes);
    const result = await mammoth.convertToHtml({ buffer });
    const text = result.value ?? '';
    const messages = result.messages ?? [];

    // Extract headings from HTML (simple regex).
    const headings = Array.from(text.matchAll(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/gi)).map(
      (m) => m[1]?.trim() ?? '',
    );

    return {
      text: text.replace(/<[^>]*>/g, '\n').replace(/\n\n+/g, '\n'),
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
export async function parseExcel(bytes: Uint8Array): Promise<ParsedContent> {
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
      allText += `\n# ${sheet}\n`;
      for (const row of data) {
        allText += JSON.stringify(row) + '\n';
      }
    }

    return {
      text: allText,
      format: 'excel',
      ...(sheets.length > 0 && { tables: sheets }),
      metadata: { sheetCount: workbook.SheetNames.length },
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
