import { z } from "zod";
import { CoreErrorSchema, FieldReportSchema } from "../../../types.js";

export const SandboxFileKindSchema = z.enum(["passport", "registration"]);

export const SandboxPickFileRequestSchema = z.object({
  kind: SandboxFileKindSchema
});

export const SandboxPickFileResponseSchema = z.object({
  canceled: z.boolean(),
  path: z.string().optional()
});

export const SandboxRunOcrRequestSchema = z.object({
  passportPath: z.string().min(1),
  registrationPath: z.string().min(1),
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
  sourcePath: z.string(),
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
  diagnostics: SandboxDiagnosticsSchema,
  field_reports: z.array(FieldReportSchema),
  errors: z.array(CoreErrorSchema).optional()
});

export const SandboxOpenDebugDirRequestSchema = z.object({
  dirPath: z.string().min(1)
});

export const SandboxOpenDebugDirResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable().optional()
});

export type SandboxPickFileRequest = z.infer<typeof SandboxPickFileRequestSchema>;
export type SandboxPickFileResponse = z.infer<typeof SandboxPickFileResponseSchema>;
export type SandboxRunOcrRequest = z.infer<typeof SandboxRunOcrRequestSchema>;
export type SandboxRunOcrResponse = z.infer<typeof SandboxRunOcrResponseSchema>;
export type SandboxOpenDebugDirRequest = z.infer<typeof SandboxOpenDebugDirRequestSchema>;
export type SandboxOpenDebugDirResponse = z.infer<typeof SandboxOpenDebugDirResponseSchema>;
