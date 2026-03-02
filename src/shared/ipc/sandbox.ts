import { z } from "zod";
import { CoreErrorSchema, FieldReportSchema } from "../../../types.js";

export const SandboxPickPdfResponseSchema = z.object({
  path: z.string()
});

export const SandboxPageRangeSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive()
});

export const SandboxRunOcrRequestSchema = z.object({
  passportPath: z.string().min(1),
  registrationPath: z.string().min(1),
  ocrVariant: z.enum(["v1", "v2"]).optional(),
  pdfPageRangePassport: SandboxPageRangeSchema.optional(),
  pdfPageRangeRegistration: SandboxPageRangeSchema.optional(),
  debugDir: z.string().nullable().optional()
});

export const SandboxRunOcrFixturesRequestSchema = z.object({
  caseId: z.enum(["case1", "case2"]),
  kind: z.enum(["pdf", "png"]),
  ocrVariant: z.enum(["v1", "v2"]).optional(),
  debugDir: z.string().nullable().optional()
});

export const SandboxOcrFieldsSchema = z.object({
  fio: z.string().nullable(),
  passport_number: z.string().nullable(),
  issued_by: z.string().nullable(),
  dept_code: z.string().nullable(),
  registration: z.string().nullable(),
  phone: z.string().nullable().optional()
});

export const SandboxNormalizationSummarySchema = z.object({
  selectedThreshold: z.number().nullable(),
  finalBlackPixelRatio: z.number().nullable(),
  usedInvert: z.boolean().nullable(),
  retryCount: z.number().nullable()
});

export const SandboxSummarySchema = z.object({
  anchorsFoundCount: z.number().nullable(),
  anchorKeys: z.array(z.string()),
  fallbackUsed: z.boolean().nullable()
});

export const SandboxFieldDiagSchema = z.object({
  field: z.string(),
  pass: z.boolean(),
  confidence: z.number(),
  psm: z.number().nullable(),
  source: z.string().nullable(),
  roi: z.string(),
  best_candidate_preview: z.string()
});

export const SandboxSourceDiagnosticsSchema = z.object({
  originalPath: z.string(),
  sourceKind: z.enum(["pdf", "png"]).optional(),
  convertedPdfPath: z.string().nullable().optional(),
  confidence_score: z.number(),
  summary: SandboxSummarySchema,
  normalization: SandboxNormalizationSummarySchema,
  fields: z.array(SandboxFieldDiagSchema),
  debugDir: z.string().nullable()
});

export const SandboxMergedDiagnosticsSchema = z.object({
  strategy: z.literal("min"),
  debugRootDir: z.string().nullable()
});

export const SandboxDiagnosticsSchema = z.object({
  passport: SandboxSourceDiagnosticsSchema.optional(),
  registration: SandboxSourceDiagnosticsSchema.optional(),
  merged: SandboxMergedDiagnosticsSchema.optional()
});

export const SandboxRunOcrResponseSchema = z.object({
  fields: SandboxOcrFieldsSchema,
  confidence_score: z.number().min(0).max(1),
  debugDir: z.string(),
  diagnostics: SandboxDiagnosticsSchema,
  field_reports: z.array(FieldReportSchema),
  errors: z.array(CoreErrorSchema).optional()
});

export const SandboxErrorSchema = CoreErrorSchema;

export const SandboxPickPdfResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: SandboxPickPdfResponseSchema.nullable()
  }),
  z.object({
    ok: z.literal(false),
    error: SandboxErrorSchema
  })
]);

export const SandboxRunOcrResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: SandboxRunOcrResponseSchema
  }),
  z.object({
    ok: z.literal(false),
    error: SandboxErrorSchema
  })
]);

export const SandboxOpenPathRequestSchema = z.object({
  path: z.string().min(1)
});

export const SandboxOpenPathDataSchema = z.object({
  opened: z.literal(true)
});

export const SandboxOpenPathResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: SandboxOpenPathDataSchema
  }),
  z.object({
    ok: z.literal(false),
    error: SandboxErrorSchema
  })
]);

export type SandboxPickPdfResponse = z.infer<typeof SandboxPickPdfResponseSchema>;
export type SandboxRunOcrRequest = z.infer<typeof SandboxRunOcrRequestSchema>;
export type SandboxRunOcrFixturesRequest = z.infer<typeof SandboxRunOcrFixturesRequestSchema>;
export type SandboxRunOcrResponse = z.infer<typeof SandboxRunOcrResponseSchema>;
export type SandboxOpenPathRequest = z.infer<typeof SandboxOpenPathRequestSchema>;
export type SandboxError = z.infer<typeof SandboxErrorSchema>;
export type SandboxPickPdfResult = z.infer<typeof SandboxPickPdfResultSchema>;
export type SandboxRunOcrResult = z.infer<typeof SandboxRunOcrResultSchema>;
export type SandboxOpenPathData = z.infer<typeof SandboxOpenPathDataSchema>;
export type SandboxOpenPathResult = z.infer<typeof SandboxOpenPathResultSchema>;
