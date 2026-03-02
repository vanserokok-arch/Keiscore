import type {
  SandboxOpenPathResult,
  SandboxPickPdfResult,
  SandboxRunOcrFixturesRequest,
  SandboxRunOcrRequest,
  SandboxRunOcrResult
} from "../shared/ipc/sandbox.js";

declare global {
  interface Window {
    keisSandbox: {
      pickPassportPdf(): Promise<SandboxPickPdfResult>;
      pickRegistrationPdf(): Promise<SandboxPickPdfResult>;
      runOcr(request: SandboxRunOcrRequest): Promise<SandboxRunOcrResult>;
      runOcrFixtures(request: SandboxRunOcrFixturesRequest): Promise<SandboxRunOcrResult>;
      openPath(path: string): Promise<SandboxOpenPathResult>;
    };
  }
}

export {};
