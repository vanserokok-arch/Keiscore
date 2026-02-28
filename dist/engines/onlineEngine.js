export class OnlineEngine {
    static async pingOnline() {
        const endpoint = process.env.ONLINE_OCR_ENDPOINT;
        if (endpoint === undefined || endpoint.trim() === "") {
            return { available: false };
        }
        return { available: true, endpoint };
    }
    static async runOcrOnRoi(roi, input, passId, timeoutMs) {
        const execute = async () => {
            const configured = input.mockLayout?.multiPass?.[roi.field]?.[passId];
            const fallbackText = input.mockLayout?.fields?.[roi.field];
            const text = configured?.text ?? fallbackText;
            if (text === undefined || text.trim() === "") {
                return null;
            }
            const confidence = configured?.confidence ?? defaultConfidence(passId);
            return {
                field: roi.field,
                text,
                raw_text: text,
                confidence,
                bbox: configured?.bbox ?? {
                    x1: roi.roi.x,
                    y1: roi.roi.y,
                    x2: roi.roi.x + roi.roi.width,
                    y2: roi.roi.y + roi.roi.height
                },
                engine_used: "online",
                pass_id: passId
            };
        };
        return withTimeout(execute(), timeoutMs);
    }
}
function defaultConfidence(passId) {
    if (passId === "A") {
        return 0.82;
    }
    if (passId === "B") {
        return 0.75;
    }
    return 0.68;
}
async function withTimeout(promise, timeoutMs) {
    let timeout = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Online OCR timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            })
        ]);
    }
    finally {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
    }
}
//# sourceMappingURL=onlineEngine.js.map