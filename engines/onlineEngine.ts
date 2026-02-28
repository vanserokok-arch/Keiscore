import type { FieldRoi, NormalizedInput, OcrCandidate } from "../types.js";

export interface OnlineAvailability {
  available: boolean;
  endpoint?: string;
}

export class OnlineEngine {
  static async pingOnline(): Promise<OnlineAvailability> {
    const endpoint = process.env.ONLINE_OCR_ENDPOINT;
    if (endpoint === undefined || endpoint.trim() === "") {
      return { available: false };
    }
    return { available: true, endpoint };
  }

  static async runOcrOnRoi(
    roi: FieldRoi,
    input: NormalizedInput,
    passId: "A" | "B" | "C",
    timeoutMs: number
  ): Promise<OcrCandidate | null> {
    const execute = async (): Promise<OcrCandidate | null> => {
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
        bbox:
          configured?.bbox ?? {
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

function defaultConfidence(passId: "A" | "B" | "C"): number {
  if (passId === "A") {
    return 0.82;
  }
  if (passId === "B") {
    return 0.75;
  }
  return 0.68;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Online OCR timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
