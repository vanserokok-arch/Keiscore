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
        source: z.enum(["roi", "mrz", "zonal_tsv", "page"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        psm: z.number().optional()
    }))
        .optional(),
    best_candidate_preview: z.string().optional(),
    best_candidate_source: z.enum(["roi", "mrz", "zonal_tsv", "page"]).optional(),
    best_candidate_normalized: z.string().optional(),
    debug_candidates: z
        .object({
        source_counts: z.object({
            roi: z.number(),
            mrz: z.number(),
            zonal_tsv: z.number(),
            page: z.number()
        }),
        top_candidates: z.array(z.object({
            raw_preview: z.string(),
            normalized_preview: z.string(),
            confidence: z.number(),
            psm: z.number().nullable(),
            source: z.enum(["roi", "mrz", "zonal_tsv", "page"]),
            validator_passed: z.boolean(),
            rejection_reason: z.string().nullable()
        }))
    })
        .optional()
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
            content_bbox: z
                .object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
                page: z.number()
            })
                .optional(),
            passport_bbox: z
                .object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
                page: z.number()
            })
                .optional(),
            applied_padding: z.number().optional(),
            final_size: z
                .object({
                width: z.number(),
                height: z.number()
            })
                .optional(),
            rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
            orientationScore: z.number(),
            deskewAngleDeg: z.number(),
            blackPixelRatio: z.number(),
            thresholdStrategy: z.string().optional(),
            safeMode: z.boolean().optional(),
            retryCount: z.number().int().nonnegative().optional(),
            usedInvert: z.boolean().optional(),
            finalThreshold: z.number().optional(),
            finalBlackPixelRatio: z.number().optional(),
            page_for_search_path: z.string().optional(),
            page_for_search_metrics: z
                .object({
                contrastScore: z.number(),
                blackPixelRatio: z.number(),
                anchorsDetected: z.number(),
                patternCandidatesDetected: z.number()
            })
                .optional()
        })
            .optional(),
        field_debug: z
            .object({
            fio: z
                .object({
                source_counts: z.object({
                    roi: z.number(),
                    mrz: z.number(),
                    zonal_tsv: z.number(),
                    page: z.number()
                }),
                top_candidates: z.array(z.object({
                    raw_preview: z.string(),
                    normalized_preview: z.string(),
                    confidence: z.number(),
                    psm: z.number().nullable(),
                    source: z.enum(["roi", "mrz", "zonal_tsv", "page"]),
                    validator_passed: z.boolean(),
                    rejection_reason: z.string().nullable()
                })),
                zonal_tsv_lines_preview: z.array(z.string()).optional(),
                zonal_tsv_empty_zones: z
                    .array(z.object({
                    reason: z.string(),
                    crop_path: z.string().nullable()
                }))
                    .optional()
            })
                .optional(),
            issued_by: z
                .object({
                source_counts: z.object({
                    roi: z.number(),
                    mrz: z.number(),
                    zonal_tsv: z.number(),
                    page: z.number()
                }),
                top_candidates: z.array(z.object({
                    raw_preview: z.string(),
                    normalized_preview: z.string(),
                    confidence: z.number(),
                    psm: z.number().nullable(),
                    source: z.enum(["roi", "mrz", "zonal_tsv", "page"]),
                    validator_passed: z.boolean(),
                    rejection_reason: z.string().nullable()
                })),
                zonal_tsv_lines_preview: z.array(z.string()).optional(),
                zonal_tsv_empty_zones: z
                    .array(z.object({
                    reason: z.string(),
                    crop_path: z.string().nullable()
                }))
                    .optional()
            })
                .optional()
        })
            .partial()
            .optional()
    })
        .optional(),
    field_reports: z.array(FieldReportSchema),
    errors: z.array(CoreErrorSchema)
});
//# sourceMappingURL=types.js.map