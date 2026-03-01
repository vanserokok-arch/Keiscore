import { contextBridge, ipcRenderer } from "electron";
import {
  SandboxOpenDebugDirResponseSchema,
  SandboxPickFileResponseSchema,
  SandboxRunOcrResponseSchema,
  type SandboxOpenDebugDirRequest,
  type SandboxPickFileRequest,
  type SandboxRunOcrRequest
} from "../shared/ipc/sandbox.js";

const sandboxApi = {
  async pickFile(request: SandboxPickFileRequest) {
    const response = await ipcRenderer.invoke("sandbox:pickFile", request);
    return SandboxPickFileResponseSchema.parse(response);
  },
  async runOcr(request: SandboxRunOcrRequest) {
    const response = await ipcRenderer.invoke("sandbox:runOcr", request);
    return SandboxRunOcrResponseSchema.parse(response);
  },
  async openDebugDir(request: SandboxOpenDebugDirRequest) {
    const response = await ipcRenderer.invoke("sandbox:openDebugDir", request);
    return SandboxOpenDebugDirResponseSchema.parse(response);
  }
};

contextBridge.exposeInMainWorld("sandboxApi", sandboxApi);
