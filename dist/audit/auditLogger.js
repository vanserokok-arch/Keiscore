export class StageAuditLogger {
    delegate;
    constructor(delegate) {
        this.delegate = delegate;
    }
    log(event) {
        this.delegate.log(event);
    }
    stage(stage, level, message, data) {
        this.log({
            ts: Date.now(),
            stage,
            level,
            message,
            data
        });
    }
}
//# sourceMappingURL=auditLogger.js.map