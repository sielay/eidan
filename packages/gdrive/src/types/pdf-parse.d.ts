declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(buffer: Uint8Array | Buffer): Promise<{
    text: string;
    numpages: number;
    version?: string;
  }>;
  export = pdfParse;
}
