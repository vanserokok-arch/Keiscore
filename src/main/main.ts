import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { registerSandboxIpcHandlers } from "./sandbox-ipc.js";

function createWindow(): BrowserWindow {
  const preloadPath = fileURLToPath(new URL("./preload.js", import.meta.url));
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
  .catch((error: unknown) => {
    console.error("Sandbox main failed during startup:", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
