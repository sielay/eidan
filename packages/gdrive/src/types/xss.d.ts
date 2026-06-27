declare module 'xss' {
  interface XSSOptions {
    whiteList?: Record<string, string[]>;
    stripIgnoredTag?: boolean;
    stripComment?: boolean;
    onTagAttr?: (tag: string, name: string, value: string) => string;
  }

  function xss(html: string, options?: XSSOptions): string;

  export = xss;
}
