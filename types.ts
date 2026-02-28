import { z } from "zod";

export type SupportedInputMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/tiff"
  | "application/pdf";

export type InputFile =
  | { kind: "path"; path: string }
  | { kind: "buffer"; filename: string; data: Buffer };

export interface AuditEvent {
  ts: number;
  stage: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

export interface AuditLogger {
  log(event: AuditEvent): void;
}

function maskSensitiveString(value: string): string {
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function sanitizeForLog(input: unknown): unknown {
  if (typeof input === "string") {
    return maskSensitiveString(input);
  }
  if (Array.isArray(input)) {
    return input.map((entry) => sanitizeForLog(entry));
  }
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = sanitizeForLog(value);
    }
    return out;
  }
  return input;
}

export class InMemoryAuditLogger implements AuditLogger {
  private readonly events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push({
      ...event,
      data: sanitizeForLog(event.data)
    });
  }

  getEvents(): readonly AuditEvent[] {
    return this.events;
  }
}

export interface ExtractOptions {
  preferOnline?: boolean;
  onlineTimeoutMs?: number;
  tesseractLang?: "rus" | string;
  maxPages?: number;
  maxInputBytes?: number;
  allowedBasePath?: string;
  ocrTimeoutMs?: number;
  pdfRenderTimeoutMs?: number;
  pdfPageRange?: {
    from: number;
    to: number;
  };
  debugIncludePiiInLogs?: boolean;
  debugUnsafeIncludeRawText?: boolean;
  logger?: AuditLogger;
}

export type CoreErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "DOCUMENT_NOT_DETECTED"
  | "PAGE_CLASSIFICATION_FAILED"
  | "ENGINE_UNAVAILABLE"
  | "FIELD_NOT_CONFIRMED"
  | "QUALITY_WARNING"
  | "REQUIRE_MANUAL_REVIEW"
  | "SECURITY_VIOLATION"
  | "INTERNAL_ERROR";

export interface CoreError {
  code: CoreErrorCode;
  message: string;
  details?: any;
}

export type PassportField =
  | "fio"
  | "passport_number"
  | "issued_by"
  | "dept_code"
  | "registration";

export interface RoiRect {
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface RoiBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FieldReport {
  field: PassportField;
  roi: RoiRect;
  roiImagePath?: string;
  postprocessed_roi_image_path?: string;
  engine_used: "online" | "tesseract" | "none";
  pass: boolean;
  pass_id?: "A" | "B" | "C" | undefined;
  confidence: number;
  validator_passed: boolean;
  rejection_reason: string | null;
  anchor_alignment_score?: number | undefined;
  attempts?: Array<{
    pass_id: "A" | "B" | "C";
    raw_text_preview: string;
    normalized_preview: string;
    confidence?: number;
    psm?: number;
  }>;
  best_candidate_preview?: string;
}

export interface ExtractionResult {
  fio: string | null;
  passport_number: string | null;
  issued_by: string | null;
  dept_code: string | null;
  registration: string | null;
  confidence_score: number;
  quality_metrics: {
    blur_score: number;
    contrast_score: number;
    geometric_score: number;
  };
  diagnostics?: {
    central_window_text_preview?: string;
    normalization?: NormalizedInput["preprocessing"];
  };
  field_reports: FieldReport[];
  errors: CoreError[];
}

export interface NormalizedInput {
  original: InputFile;
  mime: SupportedInputMime;
  kind: "image" | "pdf";
  pages: Array<{
    pageNumber: number;
    imagePath: string | null;
    width: number;
    height: number;
  }>;
  sourcePath: string | null;
  fileName: string;
  buffer: Buffer | null;
  normalizedBuffer: Buffer | null;
  width: number;
  height: number;
  quality_metrics: {
    blur_score: number;
    contrast_score: number;
    noise_score: number;
  };
  warnings: CoreError[];
  skewAngleDeg: number;
  preprocessing?: {
    applied: boolean;
    selectedThreshold: number;
    cropBbox?: RoiRect;
    rotationDeg: 0 | 90 | 180 | 270;
    orientationScore: number;
    deskewAngleDeg: number;
    blackPixelRatio: number;
  };
  mockLayout?: MockDocumentLayout;
}

export interface DocumentDetection {
  detected: boolean;
  docType: "RF_INTERNAL_PASSPORT" | "UNKNOWN";
  confidence: number;
  contour?: RoiBBox;
  aspectRatio?: number;
  areaRatio?: number;
}

export interface PerspectiveCalibration {
  geometricScore: number;
  transform: "identity";
  alignedWidth: number;
  alignedHeight: number;
  stabilityNotes: string[];
}

export interface AnchorPoint {
  x: number;
  y: number;
}

export interface AnchorResult {
  anchors: Record<string, AnchorPoint>;
  baselineY: number | null;
  lineHeight: number;
  scale: number;
  usedFallbackGrid: boolean;
  pageType: "spread_page" | "registration_page" | "unknown";
  textLineYs?: number[];
  central_window_text_preview?: string;
}

export interface FieldRoi {
  field: PassportField;
  roi: RoiRect;
  roiImagePath?: string;
}

export interface OcrCandidate {
  field: PassportField;
  text: string;
  confidence: number;
  raw_text?: string;
  normalized_text?: string;
  bbox?: RoiBBox;
  engine_used?: "online" | "tesseract";
  pass_id?: "A" | "B" | "C";
  psm?: number;
  exit_code?: number;
  stderr?: string;
  postprocessed_roi_image_path?: string;
}

export interface OcrPassResult {
  field: PassportField;
  pass_id: "A" | "B" | "C";
  text: string;
  confidence: number;
  bbox: RoiBBox;
  engine_used: "online" | "tesseract";
  raw_text?: string;
  normalized_text?: string;
  psm?: number;
  postprocessed_roi_image_path?: string;
}

export interface OcrRouterResult {
  engineUsed: "online" | "tesseract" | "none";
  candidates: OcrCandidate[];
  attempts: OcrPassResult[];
  errors: CoreError[];
}

export interface MockOcrToken {
  text: string;
  bbox: RoiBBox;
}

export interface MockDocumentLayout {
  width: number;
  height: number;
  skewDeg?: number;
  quality?: {
    blur?: number;
    contrast?: number;
    noise?: number;
  };
  contour?: RoiBBox;
  pageTypeHint?: "spread_page" | "registration_page" | "unknown";
  anchors?: Partial<Record<string, AnchorPoint>>;
  fields?: Partial<Record<PassportField, string>>;
  multiPass?: Partial<
    Record<
      PassportField,
      Partial<Record<"A" | "B" | "C", { text: string; confidence: number; bbox?: RoiBBox }>>
    >
  >;
  centralWindowText?: string;
  ocrTokens?: MockOcrToken[];
}

export const PassportFieldSchema = z.enum([
  "fio",
  "passport_number",
  "issued_by",
  "dept_code",
  "registration"
]);

export const CoreErrorSchema = z.object({
  code: z.enum([
    "UNSUPPORTED_FORMAT",
    "DOCUMENT_NOT_DETECTED",
    "PAGE_CLASSIFICATION_FAILED",
    "ENGINE_UNAVAILABLE",
    "FIELD_NOT_CONFIRMED",
    "QUALITY_WARNING",
    "REQUIRE_MANUAL_REVIEW",
    "SECURITY_VIOLATION",
    "INTERNAL_ERROR"
  ]),
  message: z.string(),
  details: z.any().optional()
});

export const FieldReportSchema = z.object({
  field: PassportFieldSchema,
  roi: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    page: z.number()
  }),
  roiImagePath: z.string().optional(),
  postprocessed_roi_image_path: z.string().optional(),
  engine_used: z.enum(["online", "tesseract", "none"]),
  pass: z.boolean(),
  pass_id: z.enum(["A", "B", "C"]).optional(),
  confidence: z.number().min(0).max(1),
  validator_passed: z.boolean(),
  rejection_reason: z.string().nullable(),
  anchor_alignment_score: z.number().min(0).max(1).optional(),
  attempts: z
    .array(
      z.object({
        pass_id: z.enum(["A", "B", "C"]),
        raw_text_preview: z.string(),
        normalized_preview: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        psm: z.number().optional()
      })
    )
    .optional(),
  best_candidate_preview: z.string().optional()
});

export const ExtractionResultSchema = z.object({
  fio: z.string().nullable(),
  passport_number: z.string().nullable(),
  issued_by: z.string().nullable(),
  dept_code: z.string().nullable(),
  registration: z.string().nullable(),
  confidence_score: z.number().min(0).max(1),
  quality_metrics: z.object({
    blur_score: z.number(),
    contrast_score: z.number(),
    geometric_score: z.number()
  }),
  diagnostics: z
    .object({
      central_window_text_preview: z.string().optional(),
      normalization: z
        .object({
          applied: z.boolean(),
          selectedThreshold: z.number(),
          cropBbox: z
            .object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
              page: z.number()
            })
            .optional(),
          rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
          orientationScore: z.number(),
          deskewAngleDeg: z.number(),
          blackPixelRatio: z.number()
        })
        .optional()
    })
    .optional(),
  field_reports: z.array(FieldReportSchema),
  errors: z.array(CoreErrorSchema)
});
