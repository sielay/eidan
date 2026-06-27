declare module 'mammoth' {
  interface ConvertToHtmlResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  function convertToHtml(options: { buffer: Buffer }): Promise<ConvertToHtmlResult>;

  export = {
    convertToHtml,
  };
}
