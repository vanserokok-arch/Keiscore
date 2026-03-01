import type {
  SandboxOpenDebugDirRequest,
  SandboxOpenDebugDirResponse,
  SandboxPickFileRequest,
  SandboxPickFileResponse,
  SandboxRunOcrRequest,
  SandboxRunOcrResponse
} from "../shared/ipc/sandbox.js";

declare global {
  interface Window {
    sandboxApi: {
      pickFile(request: SandboxPickFileRequest): Promise<SandboxPickFileResponse>;
      runOcr(request: SandboxRunOcrRequest): Promise<SandboxRunOcrResponse>;
      openDebugDir(request: SandboxOpenDebugDirRequest): Promise<SandboxOpenDebugDirResponse>;
    };
  }
}

export {};
