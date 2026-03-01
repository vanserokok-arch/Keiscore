import { useMemo, useState } from "react";
import type { CoreError, FieldReport } from "../../../types.js";
import type { SandboxRunOcrResponse } from "../../shared/ipc/sandbox.js";

type OcrStatus = "ready" | "running" | "error";

type FormState = {
  fio: string;
  passport_number: string;
  issued_by: string;
  dept_code: string;
  registration: string;
  phone: string;
};

function compactPath(value: string, max = 60): string {
  if (value.length <= max) {
    return value;
  }
  const head = Math.max(18, Math.floor(max * 0.45));
  const tail = Math.max(18, max - head - 3);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function statusLabel(status: OcrStatus): string {
  if (status === "running") {
    return "OCR...";
  }
  if (status === "error") {
    return "Ошибка";
  }
  return "Готов";
}

function fieldBadge(field: keyof FormState, value: string): "Найдено" | "Не найдено" | "Ручной ввод" {
  if (field === "phone") {
    return "Ручной ввод";
  }
  return value.trim() === "" ? "Не найдено" : "Найдено";
}

function reportRow(report: FieldReport): {
  field: string;
  pass: string;
  confidence: string;
  psm: string;
  source: string;
  roi: string;
  preview: string;
} {
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

function collectErrors(payload: SandboxRunOcrResponse | null, hardError: string | null): CoreError[] {
  if (hardError !== null) {
    return [{ code: "INTERNAL_ERROR", message: hardError }];
  }
  return payload?.errors ?? [];
}

export function OcrSandboxPage() {
  const [passportPath, setPassportPath] = useState("");
  const [registrationPath, setRegistrationPath] = useState("");
  const [form, setForm] = useState<FormState>({
    fio: "",
    passport_number: "",
    issued_by: "",
    dept_code: "",
    registration: "",
    phone: ""
  });
  const [status, setStatus] = useState<OcrStatus>("ready");
  const [progress, setProgress] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [payload, setPayload] = useState<SandboxRunOcrResponse | null>(null);
  const [hardError, setHardError] = useState<string | null>(null);

  const runDisabled = passportPath.trim() === "" || registrationPath.trim() === "" || status === "running";

  const fieldRows = useMemo(() => {
    if (payload === null) {
      return [];
    }
    return payload.field_reports.map(reportRow);
  }, [payload]);

  const errors = useMemo(() => collectErrors(payload, hardError), [payload, hardError]);

  async function onPick(kind: "passport" | "registration") {
    try {
      const result = await window.sandboxApi.pickFile({ kind });
      if (result.canceled || result.path === undefined) {
        return;
      }
      if (kind === "passport") {
        setPassportPath(result.path);
      } else {
        setRegistrationPath(result.path);
      }
      setHardError(null);
    } catch (error) {
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
    } catch (error) {
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

  return (
    <main className="ocr-sandbox">
      <div className="noise-layer" />
      <div className="vignette-layer" />
      <section className="glass left-panel">
        <h1>OCR паспорта и автозаполнение</h1>
        <article className="glass-card">
          <h2>Паспорт (2–3 стр.)</h2>
          <button onClick={() => onPick("passport")} className="secondary-btn" type="button">
            Choose file
          </button>
          <p className="path-label" title={passportPath}>
            {passportPath ? compactPath(passportPath) : "Файл не выбран"}
          </p>
        </article>
        <article className="glass-card">
          <h2>Регистрация</h2>
          <button onClick={() => onPick("registration")} className="secondary-btn" type="button">
            Choose file
          </button>
          <p className="path-label" title={registrationPath}>
            {registrationPath ? compactPath(registrationPath) : "Файл не выбран"}
          </p>
        </article>
        <button className="primary-btn" disabled={runDisabled} onClick={onRunOcr} type="button">
          Распознать данные
        </button>
        <div className="progress-wrap">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="status-row">
            <span>{statusLabel(status)}</span>
            <span>{progress}%</span>
          </div>
          {runDisabled ? <p className="hint">Выберите оба файла: паспорт и регистрацию.</p> : null}
        </div>
        <button className="toggle-btn" type="button" onClick={() => setShowDiagnostics((prev) => !prev)}>
          Диагностика
        </button>
        {showDiagnostics ? (
          <section className="diagnostics">
            <p className="diag-summary">
              Confidence: {payload?.confidence_score?.toFixed(2) ?? "-"} | merge: {payload?.diagnostics.merged?.strategy ?? "-"}
            </p>
            <p className="diag-summary">
              Passport anchors: {payload?.diagnostics.passport?.summary.anchorsFoundCount ?? "-"} | fallback:{" "}
              {payload?.diagnostics.passport?.summary.fallbackUsed === null
                ? "-"
                : payload?.diagnostics.passport?.summary.fallbackUsed
                  ? "yes"
                  : "no"}
            </p>
            <p className="diag-summary">
              Registration anchors: {payload?.diagnostics.registration?.summary.anchorsFoundCount ?? "-"} | fallback:{" "}
              {payload?.diagnostics.registration?.summary.fallbackUsed === null
                ? "-"
                : payload?.diagnostics.registration?.summary.fallbackUsed
                  ? "yes"
                  : "no"}
            </p>
            <p className="diag-summary">
              Normalization: threshold={payload?.diagnostics.passport?.normalization.selectedThreshold ?? "-"} | ratio=
              {payload?.diagnostics.passport?.normalization.finalBlackPixelRatio ?? "-"} | invert=
              {payload?.diagnostics.passport?.normalization.usedInvert === null
                ? "-"
                : payload?.diagnostics.passport?.normalization.usedInvert
                  ? "yes"
                  : "no"}{" "}
              | retries={payload?.diagnostics.passport?.normalization.retryCount ?? "-"}
            </p>
            {payload?.diagnostics.merged?.debugRootDir ? (
              <div className="debug-link-row">
                <span title={payload.diagnostics.merged.debugRootDir}>
                  Debug: {compactPath(payload.diagnostics.merged.debugRootDir, 52)}
                </span>
                <button type="button" className="secondary-btn" onClick={onOpenDebugDir}>
                  Открыть папку debug
                </button>
              </div>
            ) : null}
            <div className="diag-table-wrap">
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>field</th>
                    <th>pass</th>
                    <th>conf</th>
                    <th>psm</th>
                    <th>source</th>
                    <th>roi</th>
                    <th>best_preview</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldRows.length === 0 ? (
                    <tr>
                      <td colSpan={7}>Нет данных</td>
                    </tr>
                  ) : (
                    fieldRows.map((row) => (
                      <tr key={`${row.field}-${row.roi}`}>
                        <td>{row.field}</td>
                        <td>{row.pass}</td>
                        <td>{row.confidence}</td>
                        <td>{row.psm}</td>
                        <td>{row.source}</td>
                        <td title={row.roi}>{compactPath(row.roi, 28)}</td>
                        <td title={row.preview}>{row.preview || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {errors.length > 0 ? (
              <div className="error-block">
                {errors.map((entry, index) => (
                  <p key={`${entry.code}-${index}`}>
                    {entry.code}: {entry.message}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </section>

      <section className="glass right-panel">
        <h1>Данные клиента</h1>
        <label className="field-row">
          <span>ФИО</span>
          <em>{fieldBadge("fio", form.fio)}</em>
          <input value={form.fio} onChange={(event) => setForm({ ...form, fio: event.target.value })} />
        </label>
        <label className="field-row">
          <span>Серия и номер паспорта</span>
          <em>{fieldBadge("passport_number", form.passport_number)}</em>
          <input
            value={form.passport_number}
            onChange={(event) => setForm({ ...form, passport_number: event.target.value })}
          />
        </label>
        <label className="field-row">
          <span>Кем выдан</span>
          <em>{fieldBadge("issued_by", form.issued_by)}</em>
          <input value={form.issued_by} onChange={(event) => setForm({ ...form, issued_by: event.target.value })} />
        </label>
        <label className="field-row">
          <span>Код подразделения</span>
          <em>{fieldBadge("dept_code", form.dept_code)}</em>
          <input value={form.dept_code} onChange={(event) => setForm({ ...form, dept_code: event.target.value })} />
        </label>
        <label className="field-row">
          <span>Адрес регистрации</span>
          <em>{fieldBadge("registration", form.registration)}</em>
          <textarea
            value={form.registration}
            onChange={(event) => setForm({ ...form, registration: event.target.value })}
            rows={4}
          />
        </label>
        <label className="field-row">
          <span>Телефон</span>
          <em>{fieldBadge("phone", form.phone)}</em>
          <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
        </label>
        <button className="disabled-btn" type="button" disabled>
          Сгенерировать договор (.docx)
        </button>
      </section>
    </main>
  );
}
