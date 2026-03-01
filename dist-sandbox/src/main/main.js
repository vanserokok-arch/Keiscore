import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerSandboxIpcHandlers } from "./sandbox-ipc.js";
function createWindow() {
    const window = new BrowserWindow({
        width: 1100,
        height: 650,
        minWidth: 980,
        minHeight: 600,
        center: true,
        title: "KeisHP OCR Sandbox",
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    window.setMenuBarVisibility(false);
    window.loadFile(join(__dirname, "../../renderer/index.html"));
    return window;
}
app.whenReady().then(() => {
    registerSandboxIpcHandlers();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
//# sourceMappingURL=main.js.map