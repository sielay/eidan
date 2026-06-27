declare module 'xlsx' {
  interface Worksheet {
    [key: string]: any;
  }

  interface Workbook {
    SheetNames: string[];
    Sheets: Record<string, Worksheet | undefined>;
  }

  interface ReadOptions {
    type: 'array' | 'string' | 'buffer' | 'file';
  }

  namespace utils {
    function sheet_to_json(worksheet: Worksheet): Record<string, unknown>[];
  }

  function read(data: Uint8Array | string | Buffer, options: ReadOptions): Workbook;

  export = {
    read,
    utils,
  };
}
