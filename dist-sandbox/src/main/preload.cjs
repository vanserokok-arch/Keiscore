const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keisSandbox", {
  pickPassportPdf() {
    return ipcRenderer.invoke("sandbox:pickPassportPdf");
  },
  pickRegistrationPdf() {
    return ipcRenderer.invoke("sandbox:pickRegistrationPdf");
  },
  runOcr(input) {
    return ipcRenderer.invoke("sandbox:runOcr", input);
  },
  runOcrFixtures(input) {
    return ipcRenderer.invoke("sandbox:runOcrFixtures", input);
  },
  openPath(path) {
    return ipcRenderer.invoke("sandbox:openPath", { path });
  }
});
