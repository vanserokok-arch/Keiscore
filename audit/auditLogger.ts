import type { AuditEvent, AuditLogger } from "../types.js";

export class StageAuditLogger implements AuditLogger {
  private readonly delegate: AuditLogger;

  constructor(delegate: AuditLogger) {
    this.delegate = delegate;
  }

  log(event: AuditEvent): void {
    this.delegate.log(event);
  }

  stage(stage: string, level: AuditEvent["level"], message: string, data?: unknown): void {
    this.log({
      ts: Date.now(),
      stage,
      level,
      message,
      data
    });
  }
}
