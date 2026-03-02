import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { extractRfInternalPassport } from "../dist/index.js";

const cases = (process.env.VISUAL_CASES ?? "case1,case2")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const kinds = (process.env.VISUAL_KINDS ?? "pdf,png")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ts = new Date().toISOString().replace(/[:.]/g, "-");

async function pngToPdf(pngPath, outPdfPath) {
  const SOURCE_DPI = 300;
  const pngBytes = await import("node:fs/promises").then((m) => m.readFile(pngPath));
  const pdfDoc = await PDFDocument.create();
  const embeddedPng = await pdfDoc.embedPng(pngBytes);
  const pageWidthPt = (embeddedPng.width * 72) / SOURCE_DPI;
  const pageHeightPt = (embeddedPng.height * 72) / SOURCE_DPI;
  const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
  page.drawImage(embeddedPng, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
  const pdfBytes = await pdfDoc.save();
  await writeFile(outPdfPath, Buffer.from(pdfBytes));
  return outPdfPath;
}

function pickConfirmed(result, field) {
  const report = result.field_reports.find((item) => item.field === field);
  return Boolean(report?.validator_passed);
}

async function runSingle(caseId, kind) {
  console.log(`start ${caseId}/${kind}`);
  const root = resolve(`tmp/visual/${caseId}/${kind}/${ts}`);
  const passportDebug = join(root, "passport");
  const registrationDebug = join(root, "registration");
  await mkdir(passportDebug, { recursive: true });
  await mkdir(registrationDebug, { recursive: true });

  const passportInput = resolve(`fixtures/${caseId}/${kind}/passport.${kind}`);
  const registrationInput = resolve(`fixtures/${caseId}/${kind}/registration.${kind}`);
  let passportPath = passportInput;
  let registrationPath = registrationInput;

  if (kind === "png") {
    passportPath = await pngToPdf(passportInput, join(root, "passport.from-png.pdf"));
    registrationPath = await pngToPdf(registrationInput, join(root, "registration.from-png.pdf"));
  }

  const prevDebug = process.env.KEISCORE_DEBUG_ROI_DIR;
  process.env.KEISCORE_DEBUG_ROI_DIR = passportDebug;
  const passport = await extractRfInternalPassport({ kind: "path", path: passportPath }, { preferOnline: false });
  process.env.KEISCORE_DEBUG_ROI_DIR = registrationDebug;
  const registration = await extractRfInternalPassport({ kind: "path", path: registrationPath }, { preferOnline: false });
  if (prevDebug === undefined) {
    delete process.env.KEISCORE_DEBUG_ROI_DIR;
  } else {
    process.env.KEISCORE_DEBUG_ROI_DIR = prevDebug;
  }

  const confirmed = {
    fio: pickConfirmed(passport, "fio"),
    passport_number: pickConfirmed(passport, "passport_number"),
    issued_by: pickConfirmed(passport, "issued_by"),
    dept_code: pickConfirmed(passport, "dept_code"),
    registration: pickConfirmed(registration, "registration")
  };
  const confirmedCount = Object.values(confirmed).filter(Boolean).length;
  const summary = {
    caseId,
    kind,
    root,
    inputs: {
      passport: passportPath,
      registration: registrationPath
    },
    confirmed,
    confirmedCount,
    passportFields: {
      fio: passport.fio,
      passport_number: passport.passport_number,
      issued_by: passport.issued_by,
      dept_code: passport.dept_code
    },
    registrationField: registration.registration
  };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`done ${caseId}/${kind}: ${confirmedCount}/5 -> ${root}`);
  return summary;
}

const rows = [];
for (const caseId of cases) {
  for (const kind of kinds) {
    rows.push(await runSingle(caseId, kind));
  }
}

console.log("visual smoke summary");
for (const row of rows) {
  const status = `${row.confirmedCount}/5`;
  const missing = Object.entries(row.confirmed)
    .filter(([, ok]) => !ok)
    .map(([field]) => field)
    .join(", ");
  console.log(
    `${row.caseId}/${row.kind}: ${status} | missing: ${missing || "-"} | artifacts: ${row.root}`
  );
}
