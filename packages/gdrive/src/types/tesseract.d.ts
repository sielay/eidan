declare module 'tesseract.js' {
  interface TesseractResult {
    data: {
      text: string;
      confidence: number;
    };
  }

  interface TesseractWorker {
    recognize(image: Blob | string): Promise<TesseractResult>;
    terminate(): Promise<void>;
  }

  const Tesseract: {
    createWorker(): Promise<TesseractWorker>;
  };

  export = Tesseract;
}
