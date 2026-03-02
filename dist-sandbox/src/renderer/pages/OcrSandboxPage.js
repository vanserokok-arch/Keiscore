import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { mapRunResultToUi } from "./ocrSandboxRunResult.js";
function compactPath(value, max = 60) {
    if (value.length <= max) {
        return value;
    }
    const head = Math.max(18, Math.floor(max * 0.45));
    const tail = Math.max(18, max - head - 3);
    return `${value.slice(0, head)}...${value.slice(-tail)}`;
}
function extractFileName(path) {
    const chunks = path.split(/[\\/]/u);
    return chunks[chunks.length - 1] ?? path;
}
function statusLabel(status) {
    if (status === "running") {
        return "OCR...";
    }
    if (status === "error") {
        return "Ошибка";
    }
    return "Готов";
}
function fieldBadge(field, value) {
    if (field === "phone") {
        return "Ручной ввод";
    }
    return value.trim() === "" ? "Не найдено" : "Найдено";
}
export function OcrSandboxPage() {
    const [passportPath, setPassportPath] = useState("");
    const [registrationPath, setRegistrationPath] = useState("");
    const [form, setForm] = useState({
        fio: "",
        passport_number: "",
        issued_by: "",
        dept_code: "",
        registration: "",
        phone: ""
    });
    const [status, setStatus] = useState("ready");
    const [progress, setProgress] = useState(0);
    const [lastRunResult, setLastRunResult] = useState(null);
    const [lastThrownError, setLastThrownError] = useState(null);
    const [ocrVariant, setOcrVariant] = useState("v1");
    const runDisabled = passportPath.trim() === "" || registrationPath.trim() === "" || status === "running";
    const runResult = useMemo(() => mapRunResultToUi(lastRunResult, lastThrownError), [lastRunResult, lastThrownError]);
    async function onPickPassport() {
        try {
            const result = await window.keisSandbox.pickPassportPdf();
            if (!result.ok) {
                setLastRunResult(null);
                setLastThrownError(result.error);
                setStatus("error");
                return;
            }
            if (result.data === null) {
                return;
            }
            setPassportPath(result.data.path);
            setLastThrownError(null);
        }
        catch (error) {
            setLastRunResult(null);
            setLastThrownError(error);
            setStatus("error");
        }
    }
    async function onPickRegistration() {
        try {
            const result = await window.keisSandbox.pickRegistrationPdf();
            if (!result.ok) {
                setLastRunResult(null);
                setLastThrownError(result.error);
                setStatus("error");
                return;
            }
            if (result.data === null) {
                return;
            }
            setRegistrationPath(result.data.path);
            setLastThrownError(null);
        }
        catch (error) {
            setLastRunResult(null);
            setLastThrownError(error);
            setStatus("error");
        }
    }
    async function onRunOcr() {
        if (runDisabled) {
            return;
        }
        setStatus("running");
        setLastThrownError(null);
        setProgress(10);
        try {
            setProgress(30);
            const result = await window.keisSandbox.runOcr({
                passportPath,
                registrationPath,
                ocrVariant
            });
            setLastRunResult(result);
            setProgress(100);
            if (!result.ok) {
                setStatus("error");
                return;
            }
            setForm((current) => ({
                ...current,
                fio: result.data.fields.fio ?? "",
                passport_number: result.data.fields.passport_number ?? "",
                issued_by: result.data.fields.issued_by ?? "",
                dept_code: result.data.fields.dept_code ?? "",
                registration: result.data.fields.registration ?? ""
            }));
            setStatus((result.data.errors ?? []).length > 0 ? "error" : "ready");
        }
        catch (error) {
            setStatus("error");
            setProgress(100);
            setLastRunResult(null);
            setLastThrownError(error);
        }
    }
    async function onOpenDebugDir() {
        if (runResult.debugDir === null) {
            return;
        }
        try {
            const opened = await window.keisSandbox.openPath(runResult.debugDir);
            if (!opened.ok) {
                setLastThrownError(opened.error);
                setStatus("error");
            }
        }
        catch (error) {
            setLastThrownError(error);
            setStatus("error");
        }
    }
    return (_jsxs("main", { className: "ocr-sandbox", children: [_jsx("div", { className: "noise-layer" }), _jsx("div", { className: "vignette-layer" }), _jsxs("section", { className: "glass left-panel", children: [_jsx("h1", { children: "OCR \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430 \u0438 \u0430\u0432\u0442\u043E\u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435" }), _jsxs("article", { className: "glass-card", children: [_jsx("h2", { children: "\u041F\u0430\u0441\u043F\u043E\u0440\u0442 (2\u20133 \u0441\u0442\u0440.)" }), _jsx("button", { onClick: onPickPassport, className: "secondary-btn", type: "button", children: "\u0412\u044B\u0431\u0440\u0430\u0442\u044C PDF" }), _jsx("p", { className: "path-label", title: passportPath, children: passportPath ? extractFileName(passportPath) : "Файл не выбран" })] }), _jsxs("article", { className: "glass-card", children: [_jsx("h2", { children: "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F" }), _jsx("button", { onClick: onPickRegistration, className: "secondary-btn", type: "button", children: "\u0412\u044B\u0431\u0440\u0430\u0442\u044C PDF" }), _jsx("p", { className: "path-label", title: registrationPath, children: registrationPath ? extractFileName(registrationPath) : "Файл не выбран" })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0420\u0435\u0436\u0438\u043C OCR" }), _jsx("em", { children: ocrVariant.toUpperCase() }), _jsxs("select", { value: ocrVariant, onChange: (event) => setOcrVariant(event.target.value), children: [_jsx("option", { value: "v1", children: "OCR v1" }), _jsx("option", { value: "v2", children: "OCR v2" })] })] }), _jsx("button", { className: "primary-btn", disabled: runDisabled, onClick: onRunOcr, type: "button", children: "\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435" }), _jsxs("div", { className: "progress-wrap", children: [_jsx("div", { className: "progress-track", children: _jsx("div", { className: "progress-fill", style: { width: `${progress}%` } }) }), _jsxs("div", { className: "status-row", children: [_jsx("span", { children: statusLabel(status) }), _jsxs("span", { children: [progress, "%"] })] }), runDisabled ? _jsx("p", { className: "hint", children: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u0430 \u0444\u0430\u0439\u043B\u0430: \u043F\u0430\u0441\u043F\u043E\u0440\u0442 \u0438 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044E." }) : null] }), _jsxs("section", { className: "run-result", children: [_jsx("h2", { children: "Run Result" }), _jsx("pre", { className: "raw-json", children: runResult.rawJson }), _jsx("div", { className: "diag-table-wrap", children: _jsxs("table", { className: "diag-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "field" }), _jsx("th", { children: "pass" }), _jsx("th", { children: "conf" }), _jsx("th", { children: "psm" }), _jsx("th", { children: "source" }), _jsx("th", { children: "best_preview" })] }) }), _jsx("tbody", { children: runResult.fieldRows.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, children: "\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445" }) })) : (runResult.fieldRows.map((row, index) => (_jsxs("tr", { children: [_jsx("td", { children: row.field }), _jsx("td", { children: row.pass }), _jsx("td", { children: row.confidence }), _jsx("td", { children: row.psm }), _jsx("td", { children: row.source }), _jsx("td", { title: row.bestPreview, children: compactPath(row.bestPreview, 38) })] }, `${row.field}-${row.source}-${index}`)))) })] }) }), _jsx("div", { className: "norm-block", children: runResult.normalizationRows.length === 0 ? (_jsx("p", { className: "diag-summary", children: "Normalization: \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445" })) : (runResult.normalizationRows.map((row) => (_jsxs("p", { className: "diag-summary", children: [row.source, ": threshold=", row.selectedThreshold, " | ratio=", row.finalBlackPixelRatio, " | invert=", row.usedInvert, " | retries=", row.retryCount] }, row.source)))) }), runResult.debugDir ? (_jsxs("div", { className: "debug-link-row", children: [_jsxs("span", { title: runResult.debugDir, children: ["DebugDir: ", compactPath(runResult.debugDir, 52)] }), _jsx("button", { type: "button", className: "secondary-btn", onClick: onOpenDebugDir, children: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0430\u043F\u043A\u0443" })] })) : null, runResult.errors.length > 0 ? (_jsxs("div", { className: "error-block", children: [_jsx("p", { children: "\u041E\u0448\u0438\u0431\u043A\u0438:" }), runResult.errors.map((entry, index) => (_jsxs("p", { children: [entry.code, ": ", entry.message, " ", entry.details === undefined ? "" : `| details=${JSON.stringify(entry.details)}`] }, `${entry.code}-${index}`)))] })) : null] })] }), _jsxs("section", { className: "glass right-panel", children: [_jsx("h1", { children: "\u0414\u0430\u043D\u043D\u044B\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430" }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0424\u0418\u041E" }), _jsx("em", { children: fieldBadge("fio", form.fio) }), _jsx("input", { value: form.fio, onChange: (event) => setForm({ ...form, fio: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0421\u0435\u0440\u0438\u044F \u0438 \u043D\u043E\u043C\u0435\u0440 \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430" }), _jsx("em", { children: fieldBadge("passport_number", form.passport_number) }), _jsx("input", { value: form.passport_number, onChange: (event) => setForm({ ...form, passport_number: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u041A\u0435\u043C \u0432\u044B\u0434\u0430\u043D" }), _jsx("em", { children: fieldBadge("issued_by", form.issued_by) }), _jsx("input", { value: form.issued_by, onChange: (event) => setForm({ ...form, issued_by: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u041A\u043E\u0434 \u043F\u043E\u0434\u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0438\u044F" }), _jsx("em", { children: fieldBadge("dept_code", form.dept_code) }), _jsx("input", { value: form.dept_code, onChange: (event) => setForm({ ...form, dept_code: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0410\u0434\u0440\u0435\u0441 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438" }), _jsx("em", { children: fieldBadge("registration", form.registration) }), _jsx("textarea", { value: form.registration, onChange: (event) => setForm({ ...form, registration: event.target.value }), rows: 4 })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0422\u0435\u043B\u0435\u0444\u043E\u043D" }), _jsx("em", { children: fieldBadge("phone", form.phone) }), _jsx("input", { value: form.phone, onChange: (event) => setForm({ ...form, phone: event.target.value }) })] }), _jsx("button", { className: "disabled-btn", type: "button", disabled: true, children: "\u0421\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0434\u043E\u0433\u043E\u0432\u043E\u0440 (.docx)" })] })] }));
}
//# sourceMappingURL=OcrSandboxPage.js.map