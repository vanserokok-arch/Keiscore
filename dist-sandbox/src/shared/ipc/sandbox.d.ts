import { z } from "zod";
export declare const SandboxPickPdfResponseSchema: z.ZodObject<{
    path: z.ZodString;
}, z.core.$strip>;
export declare const SandboxPageRangeSchema: z.ZodObject<{
    from: z.ZodNumber;
    to: z.ZodNumber;
}, z.core.$strip>;
export declare const SandboxRunOcrRequestSchema: z.ZodObject<{
    passportPath: z.ZodString;
    registrationPath: z.ZodString;
    ocrVariant: z.ZodOptional<z.ZodEnum<{
        v1: "v1";
        v2: "v2";
    }>>;
    pdfPageRangePassport: z.ZodOptional<z.ZodObject<{
        from: z.ZodNumber;
        to: z.ZodNumber;
    }, z.core.$strip>>;
    pdfPageRangeRegistration: z.ZodOptional<z.ZodObject<{
        from: z.ZodNumber;
        to: z.ZodNumber;
    }, z.core.$strip>>;
    debugDir: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const SandboxRunOcrFixturesRequestSchema: z.ZodObject<{
    caseId: z.ZodEnum<{
        case1: "case1";
        case2: "case2";
    }>;
    kind: z.ZodEnum<{
        pdf: "pdf";
        png: "png";
    }>;
    ocrVariant: z.ZodOptional<z.ZodEnum<{
        v1: "v1";
        v2: "v2";
    }>>;
    debugDir: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const SandboxOcrFieldsSchema: z.ZodObject<{
    fio: z.ZodNullable<z.ZodString>;
    passport_number: z.ZodNullable<z.ZodString>;
    issued_by: z.ZodNullable<z.ZodString>;
    dept_code: z.ZodNullable<z.ZodString>;
    registration: z.ZodNullable<z.ZodString>;
    phone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const SandboxNormalizationSummarySchema: z.ZodObject<{
    selectedThreshold: z.ZodNullable<z.ZodNumber>;
    finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
    usedInvert: z.ZodNullable<z.ZodBoolean>;
    retryCount: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const SandboxSummarySchema: z.ZodObject<{
    anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
    anchorKeys: z.ZodArray<z.ZodString>;
    fallbackUsed: z.ZodNullable<z.ZodBoolean>;
}, z.core.$strip>;
export declare const SandboxFieldDiagSchema: z.ZodObject<{
    field: z.ZodString;
    pass: z.ZodBoolean;
    confidence: z.ZodNumber;
    psm: z.ZodNullable<z.ZodNumber>;
    source: z.ZodNullable<z.ZodString>;
    roi: z.ZodString;
    best_candidate_preview: z.ZodString;
}, z.core.$strip>;
export declare const SandboxSourceDiagnosticsSchema: z.ZodObject<{
    sourcePath: z.ZodString;
    sourceKind: z.ZodOptional<z.ZodEnum<{
        pdf: "pdf";
        png: "png";
    }>>;
    convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    confidence_score: z.ZodNumber;
    summary: z.ZodObject<{
        anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
        anchorKeys: z.ZodArray<z.ZodString>;
        fallbackUsed: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strip>;
    normalization: z.ZodObject<{
        selectedThreshold: z.ZodNullable<z.ZodNumber>;
        finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
        usedInvert: z.ZodNullable<z.ZodBoolean>;
        retryCount: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    fields: z.ZodArray<z.ZodObject<{
        field: z.ZodString;
        pass: z.ZodBoolean;
        confidence: z.ZodNumber;
        psm: z.ZodNullable<z.ZodNumber>;
        source: z.ZodNullable<z.ZodString>;
        roi: z.ZodString;
        best_candidate_preview: z.ZodString;
    }, z.core.$strip>>;
    debugDir: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const SandboxMergedDiagnosticsSchema: z.ZodObject<{
    strategy: z.ZodLiteral<"min">;
    debugRootDir: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const SandboxDiagnosticsSchema: z.ZodObject<{
    passport: z.ZodOptional<z.ZodObject<{
        sourcePath: z.ZodString;
        sourceKind: z.ZodOptional<z.ZodEnum<{
            pdf: "pdf";
            png: "png";
        }>>;
        convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        confidence_score: z.ZodNumber;
        summary: z.ZodObject<{
            anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
            anchorKeys: z.ZodArray<z.ZodString>;
            fallbackUsed: z.ZodNullable<z.ZodBoolean>;
        }, z.core.$strip>;
        normalization: z.ZodObject<{
            selectedThreshold: z.ZodNullable<z.ZodNumber>;
            finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
            usedInvert: z.ZodNullable<z.ZodBoolean>;
            retryCount: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        fields: z.ZodArray<z.ZodObject<{
            field: z.ZodString;
            pass: z.ZodBoolean;
            confidence: z.ZodNumber;
            psm: z.ZodNullable<z.ZodNumber>;
            source: z.ZodNullable<z.ZodString>;
            roi: z.ZodString;
            best_candidate_preview: z.ZodString;
        }, z.core.$strip>>;
        debugDir: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    registration: z.ZodOptional<z.ZodObject<{
        sourcePath: z.ZodString;
        sourceKind: z.ZodOptional<z.ZodEnum<{
            pdf: "pdf";
            png: "png";
        }>>;
        convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        confidence_score: z.ZodNumber;
        summary: z.ZodObject<{
            anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
            anchorKeys: z.ZodArray<z.ZodString>;
            fallbackUsed: z.ZodNullable<z.ZodBoolean>;
        }, z.core.$strip>;
        normalization: z.ZodObject<{
            selectedThreshold: z.ZodNullable<z.ZodNumber>;
            finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
            usedInvert: z.ZodNullable<z.ZodBoolean>;
            retryCount: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        fields: z.ZodArray<z.ZodObject<{
            field: z.ZodString;
            pass: z.ZodBoolean;
            confidence: z.ZodNumber;
            psm: z.ZodNullable<z.ZodNumber>;
            source: z.ZodNullable<z.ZodString>;
            roi: z.ZodString;
            best_candidate_preview: z.ZodString;
        }, z.core.$strip>>;
        debugDir: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    merged: z.ZodOptional<z.ZodObject<{
        strategy: z.ZodLiteral<"min">;
        debugRootDir: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SandboxRunOcrResponseSchema: z.ZodObject<{
    fields: z.ZodObject<{
        fio: z.ZodNullable<z.ZodString>;
        passport_number: z.ZodNullable<z.ZodString>;
        issued_by: z.ZodNullable<z.ZodString>;
        dept_code: z.ZodNullable<z.ZodString>;
        registration: z.ZodNullable<z.ZodString>;
        phone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    confidence_score: z.ZodNumber;
    debugDir: z.ZodString;
    diagnostics: z.ZodObject<{
        passport: z.ZodOptional<z.ZodObject<{
            sourcePath: z.ZodString;
            sourceKind: z.ZodOptional<z.ZodEnum<{
                pdf: "pdf";
                png: "png";
            }>>;
            convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidence_score: z.ZodNumber;
            summary: z.ZodObject<{
                anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
                anchorKeys: z.ZodArray<z.ZodString>;
                fallbackUsed: z.ZodNullable<z.ZodBoolean>;
            }, z.core.$strip>;
            normalization: z.ZodObject<{
                selectedThreshold: z.ZodNullable<z.ZodNumber>;
                finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
                usedInvert: z.ZodNullable<z.ZodBoolean>;
                retryCount: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            fields: z.ZodArray<z.ZodObject<{
                field: z.ZodString;
                pass: z.ZodBoolean;
                confidence: z.ZodNumber;
                psm: z.ZodNullable<z.ZodNumber>;
                source: z.ZodNullable<z.ZodString>;
                roi: z.ZodString;
                best_candidate_preview: z.ZodString;
            }, z.core.$strip>>;
            debugDir: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        registration: z.ZodOptional<z.ZodObject<{
            sourcePath: z.ZodString;
            sourceKind: z.ZodOptional<z.ZodEnum<{
                pdf: "pdf";
                png: "png";
            }>>;
            convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidence_score: z.ZodNumber;
            summary: z.ZodObject<{
                anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
                anchorKeys: z.ZodArray<z.ZodString>;
                fallbackUsed: z.ZodNullable<z.ZodBoolean>;
            }, z.core.$strip>;
            normalization: z.ZodObject<{
                selectedThreshold: z.ZodNullable<z.ZodNumber>;
                finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
                usedInvert: z.ZodNullable<z.ZodBoolean>;
                retryCount: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            fields: z.ZodArray<z.ZodObject<{
                field: z.ZodString;
                pass: z.ZodBoolean;
                confidence: z.ZodNumber;
                psm: z.ZodNullable<z.ZodNumber>;
                source: z.ZodNullable<z.ZodString>;
                roi: z.ZodString;
                best_candidate_preview: z.ZodString;
            }, z.core.$strip>>;
            debugDir: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        merged: z.ZodOptional<z.ZodObject<{
            strategy: z.ZodLiteral<"min">;
            debugRootDir: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
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
            source: z.ZodOptional<z.ZodEnum<{
                roi: "roi";
                mrz: "mrz";
                zonal_tsv: "zonal_tsv";
                page: "page";
            }>>;
            confidence: z.ZodOptional<z.ZodNumber>;
            psm: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        best_candidate_preview: z.ZodOptional<z.ZodString>;
        best_candidate_source: z.ZodOptional<z.ZodEnum<{
            roi: "roi";
            mrz: "mrz";
            zonal_tsv: "zonal_tsv";
            page: "page";
        }>>;
        best_candidate_normalized: z.ZodOptional<z.ZodString>;
        debug_candidates: z.ZodOptional<z.ZodObject<{
            source_counts: z.ZodObject<{
                roi: z.ZodNumber;
                mrz: z.ZodNumber;
                zonal_tsv: z.ZodNumber;
                page: z.ZodNumber;
            }, z.core.$strip>;
            top_candidates: z.ZodArray<z.ZodObject<{
                raw_preview: z.ZodString;
                normalized_preview: z.ZodString;
                confidence: z.ZodNumber;
                psm: z.ZodNullable<z.ZodNumber>;
                source: z.ZodEnum<{
                    roi: "roi";
                    mrz: "mrz";
                    zonal_tsv: "zonal_tsv";
                    page: "page";
                }>;
                validator_passed: z.ZodBoolean;
                rejection_reason: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    errors: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const SandboxErrorSchema: z.ZodObject<{
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
export declare const SandboxPickPdfResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    ok: z.ZodLiteral<true>;
    data: z.ZodNullable<z.ZodObject<{
        path: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
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
}, z.core.$strip>]>;
export declare const SandboxRunOcrResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    ok: z.ZodLiteral<true>;
    data: z.ZodObject<{
        fields: z.ZodObject<{
            fio: z.ZodNullable<z.ZodString>;
            passport_number: z.ZodNullable<z.ZodString>;
            issued_by: z.ZodNullable<z.ZodString>;
            dept_code: z.ZodNullable<z.ZodString>;
            registration: z.ZodNullable<z.ZodString>;
            phone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>;
        confidence_score: z.ZodNumber;
        debugDir: z.ZodString;
        diagnostics: z.ZodObject<{
            passport: z.ZodOptional<z.ZodObject<{
                sourcePath: z.ZodString;
                sourceKind: z.ZodOptional<z.ZodEnum<{
                    pdf: "pdf";
                    png: "png";
                }>>;
                convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                confidence_score: z.ZodNumber;
                summary: z.ZodObject<{
                    anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
                    anchorKeys: z.ZodArray<z.ZodString>;
                    fallbackUsed: z.ZodNullable<z.ZodBoolean>;
                }, z.core.$strip>;
                normalization: z.ZodObject<{
                    selectedThreshold: z.ZodNullable<z.ZodNumber>;
                    finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
                    usedInvert: z.ZodNullable<z.ZodBoolean>;
                    retryCount: z.ZodNullable<z.ZodNumber>;
                }, z.core.$strip>;
                fields: z.ZodArray<z.ZodObject<{
                    field: z.ZodString;
                    pass: z.ZodBoolean;
                    confidence: z.ZodNumber;
                    psm: z.ZodNullable<z.ZodNumber>;
                    source: z.ZodNullable<z.ZodString>;
                    roi: z.ZodString;
                    best_candidate_preview: z.ZodString;
                }, z.core.$strip>>;
                debugDir: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            registration: z.ZodOptional<z.ZodObject<{
                sourcePath: z.ZodString;
                sourceKind: z.ZodOptional<z.ZodEnum<{
                    pdf: "pdf";
                    png: "png";
                }>>;
                convertedPdfPath: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                confidence_score: z.ZodNumber;
                summary: z.ZodObject<{
                    anchorsFoundCount: z.ZodNullable<z.ZodNumber>;
                    anchorKeys: z.ZodArray<z.ZodString>;
                    fallbackUsed: z.ZodNullable<z.ZodBoolean>;
                }, z.core.$strip>;
                normalization: z.ZodObject<{
                    selectedThreshold: z.ZodNullable<z.ZodNumber>;
                    finalBlackPixelRatio: z.ZodNullable<z.ZodNumber>;
                    usedInvert: z.ZodNullable<z.ZodBoolean>;
                    retryCount: z.ZodNullable<z.ZodNumber>;
                }, z.core.$strip>;
                fields: z.ZodArray<z.ZodObject<{
                    field: z.ZodString;
                    pass: z.ZodBoolean;
                    confidence: z.ZodNumber;
                    psm: z.ZodNullable<z.ZodNumber>;
                    source: z.ZodNullable<z.ZodString>;
                    roi: z.ZodString;
                    best_candidate_preview: z.ZodString;
                }, z.core.$strip>>;
                debugDir: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            merged: z.ZodOptional<z.ZodObject<{
                strategy: z.ZodLiteral<"min">;
                debugRootDir: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
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
                source: z.ZodOptional<z.ZodEnum<{
                    roi: "roi";
                    mrz: "mrz";
                    zonal_tsv: "zonal_tsv";
                    page: "page";
                }>>;
                confidence: z.ZodOptional<z.ZodNumber>;
                psm: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>>;
            best_candidate_preview: z.ZodOptional<z.ZodString>;
            best_candidate_source: z.ZodOptional<z.ZodEnum<{
                roi: "roi";
                mrz: "mrz";
                zonal_tsv: "zonal_tsv";
                page: "page";
            }>>;
            best_candidate_normalized: z.ZodOptional<z.ZodString>;
            debug_candidates: z.ZodOptional<z.ZodObject<{
                source_counts: z.ZodObject<{
                    roi: z.ZodNumber;
                    mrz: z.ZodNumber;
                    zonal_tsv: z.ZodNumber;
                    page: z.ZodNumber;
                }, z.core.$strip>;
                top_candidates: z.ZodArray<z.ZodObject<{
                    raw_preview: z.ZodString;
                    normalized_preview: z.ZodString;
                    confidence: z.ZodNumber;
                    psm: z.ZodNullable<z.ZodNumber>;
                    source: z.ZodEnum<{
                        roi: "roi";
                        mrz: "mrz";
                        zonal_tsv: "zonal_tsv";
                        page: "page";
                    }>;
                    validator_passed: z.ZodBoolean;
                    rejection_reason: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        errors: z.ZodOptional<z.ZodArray<z.ZodObject<{
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
        }, z.core.$strip>>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
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
}, z.core.$strip>]>;
export declare const SandboxOpenPathRequestSchema: z.ZodObject<{
    path: z.ZodString;
}, z.core.$strip>;
export declare const SandboxOpenPathDataSchema: z.ZodObject<{
    opened: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const SandboxOpenPathResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    ok: z.ZodLiteral<true>;
    data: z.ZodObject<{
        opened: z.ZodLiteral<true>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
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
}, z.core.$strip>]>;
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
