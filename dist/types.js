import { z } from "zod";
function maskSensitiveString(value) {
    if (value.length <= 4) {
        return "****";
    }
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
function sanitizeForLog(input) {
    if (typeof input === "string") {
        return maskSensitiveString(input);
    }
    if (Array.isArray(input)) {
        return input.map((entry) => sanitizeForLog(entry));
    }
    if (input !== null && typeof input === "object") {
        const record = input;
        const out = {};
        for (const [key, value] of Object.entries(record)) {
            out[key] = sanitizeForLog(value);
        }
        return out;
    }
    return input;
}
export class InMemoryAuditLogger {
    events = [];
    log(event) {
        this.events.push({
            ...event,
            data: sanitizeForLog(event.data)
        });
    }
    getEvents() {
        return this.events;
    }
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
        .array(z.object({
        pass_id: z.enum(["A", "B", "C"]),
        raw_text_preview: z.string(),
        normalized_preview: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        psm: z.number().optional()
    }))
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
//# sourceMappingURL=types.js.map