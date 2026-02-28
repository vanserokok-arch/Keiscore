import type { AuditEvent, AuditLogger } from "../types.js";
export declare class StageAuditLogger implements AuditLogger {
    private readonly delegate;
    constructor(delegate: AuditLogger);
    log(event: AuditEvent): void;
    stage(stage: string, level: AuditEvent["level"], message: string, data?: unknown): void;
}
