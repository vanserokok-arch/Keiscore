import { z } from "zod";
export type SupportedInputMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/tiff" | "application/pdf";
export type InputFile = {
    kind: "path";
    path: string;
} | {
    kind: "buffer";
    filename: string;
    data: Buffer;
};
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
export declare class InMemoryAuditLogger implements AuditLogger {
    private readonly events;
    log(event: AuditEvent): void;
    getEvents(): readonly AuditEvent[];
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
export type CoreErrorCode = "UNSUPPORTED_FORMAT" | "DOCUMENT_NOT_DETECTED" | "PAGE_CLASSIFICATION_FAILED" | "ENGINE_UNAVAILABLE" | "FIELD_NOT_CONFIRMED" | "QUALITY_WARNING" | "REQUIRE_MANUAL_REVIEW" | "SECURITY_VIOLATION" | "INTERNAL_ERROR";
export interface CoreError {
    code: CoreErrorCode;
    message: string;
    details?: any;
}
export type PassportField = "fio" | "passport_number" | "issued_by" | "dept_code" | "registration";
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
    multiPass?: Partial<Record<PassportField, Partial<Record<"A" | "B" | "C", {
        text: string;
        confidence: number;
        bbox?: RoiBBox;
    }>>>>;
    centralWindowText?: string;
    ocrTokens?: MockOcrToken[];
}
export declare const PassportFieldSchema: z.ZodEnum<{
    fio: "fio";
    passport_number: "passport_number";
    issued_by: "issued_by";
    dept_code: "dept_code";
    registration: "registration";
}>;
export declare const CoreErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT";
        DOCUMENT_NOT_DETECTED: "DOCUMENT_NOT_DETECTED";
        PAGE_CLASSIFICATION_FAILED: "PAGE_CLASSIFICATION_FAILED";
        ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE";
        FIELD_NOT_CONFIRMED: "FIELD_NOT_CONFIRMED";
        QUALITY_WARNING: "QUALITY_WARNING";
        REQUIRE_MANUAL_REVIEW: "REQUIRE_MANUAL_REVIEW";
        SECURITY_VIOLATION: "SECURITY_VIOLATION";
        INTERNAL_ERROR: "INTERNAL_ERROR";
    }>;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodAny>;
}, z.core.$strip>;
export declare const FieldReportSchema: z.ZodObject<{
    field: z.ZodEnum<{
        fio: "fio";
        passport_number: "passport_number";
        issued_by: "issued_by";
        dept_code: "dept_code";
        registration: "registration";
    }>;
    roi: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
        page: z.ZodNumber;
    }, z.core.$strip>;
    roiImagePath: z.ZodOptional<z.ZodString>;
    postprocessed_roi_image_path: z.ZodOptional<z.ZodString>;
    engine_used: z.ZodEnum<{
        online: "online";
        tesseract: "tesseract";
        none: "none";
    }>;
    pass: z.ZodBoolean;
    pass_id: z.ZodOptional<z.ZodEnum<{
        A: "A";
        B: "B";
        C: "C";
    }>>;
    confidence: z.ZodNumber;
    validator_passed: z.ZodBoolean;
    rejection_reason: z.ZodNullable<z.ZodString>;
    anchor_alignment_score: z.ZodOptional<z.ZodNumber>;
    attempts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        pass_id: z.ZodEnum<{
            A: "A";
            B: "B";
            C: "C";
        }>;
        raw_text_preview: z.ZodString;
        normalized_preview: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        psm: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    best_candidate_preview: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ExtractionResultSchema: z.ZodObject<{
    fio: z.ZodNullable<z.ZodString>;
    passport_number: z.ZodNullable<z.ZodString>;
    issued_by: z.ZodNullable<z.ZodString>;
    dept_code: z.ZodNullable<z.ZodString>;
    registration: z.ZodNullable<z.ZodString>;
    confidence_score: z.ZodNumber;
    quality_metrics: z.ZodObject<{
        blur_score: z.ZodNumber;
        contrast_score: z.ZodNumber;
        geometric_score: z.ZodNumber;
    }, z.core.$strip>;
    diagnostics: z.ZodOptional<z.ZodObject<{
        central_window_text_preview: z.ZodOptional<z.ZodString>;
        normalization: z.ZodOptional<z.ZodObject<{
            applied: z.ZodBoolean;
            selectedThreshold: z.ZodNumber;
            cropBbox: z.ZodOptional<z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
                page: z.ZodNumber;
            }, z.core.$strip>>;
            rotationDeg: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<90>, z.ZodLiteral<180>, z.ZodLiteral<270>]>;
            orientationScore: z.ZodNumber;
            deskewAngleDeg: z.ZodNumber;
            blackPixelRatio: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    field_reports: z.ZodArray<z.ZodObject<{
        field: z.ZodEnum<{
            fio: "fio";
            passport_number: "passport_number";
            issued_by: "issued_by";
            dept_code: "dept_code";
            registration: "registration";
        }>;
        roi: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
            page: z.ZodNumber;
        }, z.core.$strip>;
        roiImagePath: z.ZodOptional<z.ZodString>;
        postprocessed_roi_image_path: z.ZodOptional<z.ZodString>;
        engine_used: z.ZodEnum<{
            online: "online";
            tesseract: "tesseract";
            none: "none";
        }>;
        pass: z.ZodBoolean;
        pass_id: z.ZodOptional<z.ZodEnum<{
            A: "A";
            B: "B";
            C: "C";
        }>>;
        confidence: z.ZodNumber;
        validator_passed: z.ZodBoolean;
        rejection_reason: z.ZodNullable<z.ZodString>;
        anchor_alignment_score: z.ZodOptional<z.ZodNumber>;
        attempts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            pass_id: z.ZodEnum<{
                A: "A";
                B: "B";
                C: "C";
            }>;
            raw_text_preview: z.ZodString;
            normalized_preview: z.ZodString;
            confidence: z.ZodOptional<z.ZodNumber>;
            psm: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        best_candidate_preview: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    errors: z.ZodArray<z.ZodObject<{
        code: z.ZodEnum<{
            UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT";
            DOCUMENT_NOT_DETECTED: "DOCUMENT_NOT_DETECTED";
            PAGE_CLASSIFICATION_FAILED: "PAGE_CLASSIFICATION_FAILED";
            ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE";
            FIELD_NOT_CONFIRMED: "FIELD_NOT_CONFIRMED";
            QUALITY_WARNING: "QUALITY_WARNING";
            REQUIRE_MANUAL_REVIEW: "REQUIRE_MANUAL_REVIEW";
            SECURITY_VIOLATION: "SECURITY_VIOLATION";
            INTERNAL_ERROR: "INTERNAL_ERROR";
        }>;
        message: z.ZodString;
        details: z.ZodOptional<z.ZodAny>;
    }, z.core.$strip>>;
}, z.core.$strip>;
