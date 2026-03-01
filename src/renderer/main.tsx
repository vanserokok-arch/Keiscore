import React from "react";
import { createRoot } from "react-dom/client";
import { OcrSandboxPage } from "./pages/OcrSandboxPage.js";
import "./styles/ocr-sandbox.css";

const rootNode = document.getElementById("root");
if (rootNode === null) {
  throw new Error("Root node not found");
}

createRoot(rootNode).render(
  <React.StrictMode>
    <OcrSandboxPage />
  </React.StrictMode>
);
