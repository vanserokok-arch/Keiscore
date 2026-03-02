import { jsx as _jsx } from "react/jsx-runtime";
import React from "react";
import { createRoot } from "react-dom/client";
import { OcrSandboxPage } from "./pages/OcrSandboxPage.js";
import "./styles/ocr-sandbox.css";
const rootNode = document.getElementById("root");
if (rootNode === null) {
    throw new Error("Root node not found");
}
console.log("sandbox renderer boot");
createRoot(rootNode).render(_jsx(React.StrictMode, { children: _jsx(OcrSandboxPage, {}) }));
//# sourceMappingURL=main.js.map