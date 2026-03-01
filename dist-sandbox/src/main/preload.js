import { contextBridge, ipcRenderer } from "electron";
import { SandboxOpenDebugDirResponseSchema, SandboxPickFileResponseSchema, SandboxRunOcrResponseSchema } from "../shared/ipc/sandbox.js";
const sandboxApi = {
    async pickFile(request) {
        const response = await ipcRenderer.invoke("sandbox:pickFile", request);
        return SandboxPickFileResponseSchema.parse(response);
    },
    async runOcr(request) {
        const response = await ipcRenderer.invoke("sandbox:runOcr", request);
        return SandboxRunOcrResponseSchema.parse(response);
    },
    async openDebugDir(request) {
        const response = await ipcRenderer.invoke("sandbox:openDebugDir", request);
        return SandboxOpenDebugDirResponseSchema.parse(response);
    }
};
contextBridge.exposeInMainWorld("sandboxApi", sandboxApi);
//# sourceMappingURL=preload.js.map