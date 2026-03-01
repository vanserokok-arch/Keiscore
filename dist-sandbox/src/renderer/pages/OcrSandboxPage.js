import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
function compactPath(value, max = 60) {
    if (value.length <= max) {
        return value;
    }
    const head = Math.max(18, Math.floor(max * 0.45));
    const tail = Math.max(18, max - head - 3);
    return `${value.slice(0, head)}...${value.slice(-tail)}`;
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
function reportRow(report) {
    const attempt = (report.attempts ?? []).find((candidate) => candidate.pass_id === report.pass_id);
    const roi = `x:${report.roi.x} y:${report.roi.y} w:${report.roi.width} h:${report.roi.height}`;
    return {
        field: report.field,
        pass: report.pass ? "pass" : "fail",
        confidence: report.confidence.toFixed(2),
        psm: attempt?.psm === undefined ? "-" : String(attempt.psm),
        source: report.best_candidate_source ?? attempt?.source ?? "-",
        roi,
        preview: String(report.best_candidate_preview ?? "").slice(0, 70)
    };
}
function collectErrors(payload, hardError) {
    if (hardError !== null) {
        return [{ code: "INTERNAL_ERROR", message: hardError }];
    }
    return payload?.errors ?? [];
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
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [payload, setPayload] = useState(null);
    const [hardError, setHardError] = useState(null);
    const runDisabled = passportPath.trim() === "" || registrationPath.trim() === "" || status === "running";
    const fieldRows = useMemo(() => {
        if (payload === null) {
            return [];
        }
        return payload.field_reports.map(reportRow);
    }, [payload]);
    const errors = useMemo(() => collectErrors(payload, hardError), [payload, hardError]);
    async function onPick(kind) {
        try {
            const result = await window.sandboxApi.pickFile({ kind });
            if (result.canceled || result.path === undefined) {
                return;
            }
            if (kind === "passport") {
                setPassportPath(result.path);
            }
            else {
                setRegistrationPath(result.path);
            }
            setHardError(null);
        }
        catch (error) {
            setHardError(error instanceof Error ? error.message : "Не удалось выбрать файл.");
            setStatus("error");
        }
    }
    async function onRunOcr() {
        if (runDisabled) {
            return;
        }
        setStatus("running");
        setHardError(null);
        setProgress(10);
        try {
            setProgress(30);
            const result = await window.sandboxApi.runOcr({
                passportPath,
                registrationPath
            });
            setPayload(result);
            setForm((current) => ({
                ...current,
                fio: result.fields.fio ?? "",
                passport_number: result.fields.passport_number ?? "",
                issued_by: result.fields.issued_by ?? "",
                dept_code: result.fields.dept_code ?? "",
                registration: result.fields.registration ?? ""
            }));
            setProgress(100);
            setStatus((result.errors ?? []).length > 0 ? "error" : "ready");
        }
        catch (error) {
            setStatus("error");
            setProgress(100);
            setHardError(error instanceof Error ? error.message : "OCR pipeline завершился с ошибкой.");
        }
    }
    async function onOpenDebugDir() {
        const debugDir = payload?.diagnostics.merged?.debugRootDir ?? null;
        if (debugDir === null) {
            return;
        }
        const opened = await window.sandboxApi.openDebugDir({ dirPath: debugDir });
        if (!opened.ok) {
            setHardError(opened.message ?? "Не удалось открыть debug-папку.");
            setStatus("error");
        }
    }
    return (_jsxs("main", { className: "ocr-sandbox", children: [_jsx("div", { className: "noise-layer" }), _jsx("div", { className: "vignette-layer" }), _jsxs("section", { className: "glass left-panel", children: [_jsx("h1", { children: "OCR \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430 \u0438 \u0430\u0432\u0442\u043E\u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435" }), _jsxs("article", { className: "glass-card", children: [_jsx("h2", { children: "\u041F\u0430\u0441\u043F\u043E\u0440\u0442 (2\u20133 \u0441\u0442\u0440.)" }), _jsx("button", { onClick: () => onPick("passport"), className: "secondary-btn", type: "button", children: "Choose file" }), _jsx("p", { className: "path-label", title: passportPath, children: passportPath ? compactPath(passportPath) : "Файл не выбран" })] }), _jsxs("article", { className: "glass-card", children: [_jsx("h2", { children: "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F" }), _jsx("button", { onClick: () => onPick("registration"), className: "secondary-btn", type: "button", children: "Choose file" }), _jsx("p", { className: "path-label", title: registrationPath, children: registrationPath ? compactPath(registrationPath) : "Файл не выбран" })] }), _jsx("button", { className: "primary-btn", disabled: runDisabled, onClick: onRunOcr, type: "button", children: "\u0420\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435" }), _jsxs("div", { className: "progress-wrap", children: [_jsx("div", { className: "progress-track", children: _jsx("div", { className: "progress-fill", style: { width: `${progress}%` } }) }), _jsxs("div", { className: "status-row", children: [_jsx("span", { children: statusLabel(status) }), _jsxs("span", { children: [progress, "%"] })] }), runDisabled ? _jsx("p", { className: "hint", children: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0431\u0430 \u0444\u0430\u0439\u043B\u0430: \u043F\u0430\u0441\u043F\u043E\u0440\u0442 \u0438 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044E." }) : null] }), _jsx("button", { className: "toggle-btn", type: "button", onClick: () => setShowDiagnostics((prev) => !prev), children: "\u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430" }), showDiagnostics ? (_jsxs("section", { className: "diagnostics", children: [_jsxs("p", { className: "diag-summary", children: ["Confidence: ", payload?.confidence_score?.toFixed(2) ?? "-", " | merge: ", payload?.diagnostics.merged?.strategy ?? "-"] }), _jsxs("p", { className: "diag-summary", children: ["Passport anchors: ", payload?.diagnostics.passport?.summary.anchorsFoundCount ?? "-", " | fallback:", " ", payload?.diagnostics.passport?.summary.fallbackUsed === null
                                        ? "-"
                                        : payload?.diagnostics.passport?.summary.fallbackUsed
                                            ? "yes"
                                            : "no"] }), _jsxs("p", { className: "diag-summary", children: ["Registration anchors: ", payload?.diagnostics.registration?.summary.anchorsFoundCount ?? "-", " | fallback:", " ", payload?.diagnostics.registration?.summary.fallbackUsed === null
                                        ? "-"
                                        : payload?.diagnostics.registration?.summary.fallbackUsed
                                            ? "yes"
                                            : "no"] }), _jsxs("p", { className: "diag-summary", children: ["Normalization: threshold=", payload?.diagnostics.passport?.normalization.selectedThreshold ?? "-", " | ratio=", payload?.diagnostics.passport?.normalization.finalBlackPixelRatio ?? "-", " | invert=", payload?.diagnostics.passport?.normalization.usedInvert === null
                                        ? "-"
                                        : payload?.diagnostics.passport?.normalization.usedInvert
                                            ? "yes"
                                            : "no", " ", "| retries=", payload?.diagnostics.passport?.normalization.retryCount ?? "-"] }), payload?.diagnostics.merged?.debugRootDir ? (_jsxs("div", { className: "debug-link-row", children: [_jsxs("span", { title: payload.diagnostics.merged.debugRootDir, children: ["Debug: ", compactPath(payload.diagnostics.merged.debugRootDir, 52)] }), _jsx("button", { type: "button", className: "secondary-btn", onClick: onOpenDebugDir, children: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0430\u043F\u043A\u0443 debug" })] })) : null, _jsx("div", { className: "diag-table-wrap", children: _jsxs("table", { className: "diag-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "field" }), _jsx("th", { children: "pass" }), _jsx("th", { children: "conf" }), _jsx("th", { children: "psm" }), _jsx("th", { children: "source" }), _jsx("th", { children: "roi" }), _jsx("th", { children: "best_preview" })] }) }), _jsx("tbody", { children: fieldRows.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, children: "\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445" }) })) : (fieldRows.map((row) => (_jsxs("tr", { children: [_jsx("td", { children: row.field }), _jsx("td", { children: row.pass }), _jsx("td", { children: row.confidence }), _jsx("td", { children: row.psm }), _jsx("td", { children: row.source }), _jsx("td", { title: row.roi, children: compactPath(row.roi, 28) }), _jsx("td", { title: row.preview, children: row.preview || "-" })] }, `${row.field}-${row.roi}`)))) })] }) }), errors.length > 0 ? (_jsx("div", { className: "error-block", children: errors.map((entry, index) => (_jsxs("p", { children: [entry.code, ": ", entry.message] }, `${entry.code}-${index}`))) })) : null] })) : null] }), _jsxs("section", { className: "glass right-panel", children: [_jsx("h1", { children: "\u0414\u0430\u043D\u043D\u044B\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430" }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0424\u0418\u041E" }), _jsx("em", { children: fieldBadge("fio", form.fio) }), _jsx("input", { value: form.fio, onChange: (event) => setForm({ ...form, fio: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0421\u0435\u0440\u0438\u044F \u0438 \u043D\u043E\u043C\u0435\u0440 \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430" }), _jsx("em", { children: fieldBadge("passport_number", form.passport_number) }), _jsx("input", { value: form.passport_number, onChange: (event) => setForm({ ...form, passport_number: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u041A\u0435\u043C \u0432\u044B\u0434\u0430\u043D" }), _jsx("em", { children: fieldBadge("issued_by", form.issued_by) }), _jsx("input", { value: form.issued_by, onChange: (event) => setForm({ ...form, issued_by: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u041A\u043E\u0434 \u043F\u043E\u0434\u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0438\u044F" }), _jsx("em", { children: fieldBadge("dept_code", form.dept_code) }), _jsx("input", { value: form.dept_code, onChange: (event) => setForm({ ...form, dept_code: event.target.value }) })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0410\u0434\u0440\u0435\u0441 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438" }), _jsx("em", { children: fieldBadge("registration", form.registration) }), _jsx("textarea", { value: form.registration, onChange: (event) => setForm({ ...form, registration: event.target.value }), rows: 4 })] }), _jsxs("label", { className: "field-row", children: [_jsx("span", { children: "\u0422\u0435\u043B\u0435\u0444\u043E\u043D" }), _jsx("em", { children: fieldBadge("phone", form.phone) }), _jsx("input", { value: form.phone, onChange: (event) => setForm({ ...form, phone: event.target.value }) })] }), _jsx("button", { className: "disabled-btn", type: "button", disabled: true, children: "\u0421\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0434\u043E\u0433\u043E\u0432\u043E\u0440 (.docx)" })] })] }));
}
//# sourceMappingURL=OcrSandboxPage.js.map