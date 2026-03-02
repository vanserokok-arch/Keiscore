import { useMemo, useState } from "react";
import type { SandboxRunOcrResult } from "../../shared/ipc/sandbox.js";
import { mapRunResultToUi } from "./ocrSandboxRunResult.js";

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

function extractFileName(path: string): string {
  const chunks = path.split(/[\\/]/u);
  return chunks[chunks.length - 1] ?? path;
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
  const [lastRunResult, setLastRunResult] = useState<SandboxRunOcrResult | null>(null);
  const [lastThrownError, setLastThrownError] = useState<unknown | null>(null);

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
    } catch (error) {
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
    } catch (error) {
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
        registrationPath
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
    } catch (error) {
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
    } catch (error) {
      setLastThrownError(error);
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
          <button onClick={onPickPassport} className="secondary-btn" type="button">
            Выбрать PDF
          </button>
          <p className="path-label" title={passportPath}>
            {passportPath ? extractFileName(passportPath) : "Файл не выбран"}
          </p>
        </article>
        <article className="glass-card">
          <h2>Регистрация</h2>
          <button onClick={onPickRegistration} className="secondary-btn" type="button">
            Выбрать PDF
          </button>
          <p className="path-label" title={registrationPath}>
            {registrationPath ? extractFileName(registrationPath) : "Файл не выбран"}
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

        <section className="run-result">
          <h2>Run Result</h2>
          <pre className="raw-json">{runResult.rawJson}</pre>

          <div className="diag-table-wrap">
            <table className="diag-table">
              <thead>
                <tr>
                  <th>field</th>
                  <th>pass</th>
                  <th>conf</th>
                  <th>psm</th>
                  <th>source</th>
                  <th>best_preview</th>
                </tr>
              </thead>
              <tbody>
                {runResult.fieldRows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>Нет данных</td>
                  </tr>
                ) : (
                  runResult.fieldRows.map((row, index) => (
                    <tr key={`${row.field}-${row.source}-${index}`}>
                      <td>{row.field}</td>
                      <td>{row.pass}</td>
                      <td>{row.confidence}</td>
                      <td>{row.psm}</td>
                      <td>{row.source}</td>
                      <td title={row.bestPreview}>{compactPath(row.bestPreview, 38)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="norm-block">
            {runResult.normalizationRows.length === 0 ? (
              <p className="diag-summary">Normalization: нет данных</p>
            ) : (
              runResult.normalizationRows.map((row) => (
                <p className="diag-summary" key={row.source}>
                  {row.source}: threshold={row.selectedThreshold} | ratio={row.finalBlackPixelRatio} | invert={row.usedInvert} | retries={row.retryCount}
                </p>
              ))
            )}
          </div>

          {runResult.debugDir ? (
            <div className="debug-link-row">
              <span title={runResult.debugDir}>DebugDir: {compactPath(runResult.debugDir, 52)}</span>
              <button type="button" className="secondary-btn" onClick={onOpenDebugDir}>
                Открыть папку
              </button>
            </div>
          ) : null}

          {runResult.errors.length > 0 ? (
            <div className="error-block">
              <p>Ошибки:</p>
              {runResult.errors.map((entry, index) => (
                <p key={`${entry.code}-${index}`}>
                  {entry.code}: {entry.message} {entry.details === undefined ? "" : `| details=${JSON.stringify(entry.details)}`}
                </p>
              ))}
            </div>
          ) : null}
        </section>
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
