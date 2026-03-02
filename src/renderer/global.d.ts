import type {
  SandboxOpenPathResult,
  SandboxPickPdfResult,
  SandboxRunOcrRequest,
  SandboxRunOcrResult
} from "../shared/ipc/sandbox.js";

declare global {
  interface Window {
    keisSandbox: {
      pickPassportPdf(): Promise<SandboxPickPdfResult>;
      pickRegistrationPdf(): Promise<SandboxPickPdfResult>;
      runOcr(request: SandboxRunOcrRequest): Promise<SandboxRunOcrResult>;
      openPath(path: string): Promise<SandboxOpenPathResult>;
    };
  }
}

export {};
