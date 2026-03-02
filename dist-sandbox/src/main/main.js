import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { registerSandboxIpcHandlers } from "./sandbox-ipc.js";
function createWindow() {
    const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
    const rendererPath = fileURLToPath(new URL("../../renderer/index.html", import.meta.url));
    const window = new BrowserWindow({
        width: 1100,
        height: 650,
        minWidth: 980,
        minHeight: 600,
        center: true,
        title: "KeisHP OCR Sandbox",
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    window.webContents.on("did-fail-load", (_event, code, desc, url) => {
        console.error("did-fail-load", { code, desc, url });
    });
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        console.log("[renderer]", { level, message, line, sourceId });
    });
    window.webContents.on("render-process-gone", (_event, details) => {
        console.error("render-process-gone", details);
    });
    window.webContents.on("did-finish-load", () => {
        console.log("renderer did-finish-load");
    });
    if (process.env.SANDBOX_DEVTOOLS === "1") {
        window.webContents.openDevTools({ mode: "detach" });
    }
    window.setMenuBarVisibility(false);
    window.loadFile(rendererPath);
    return window;
}
app.whenReady()
    .then(() => {
    registerSandboxIpcHandlers();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
})
    .catch((error) => {
    console.error("Sandbox main failed during startup:", error);
    app.quit();
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
//# sourceMappingURL=main.js.map