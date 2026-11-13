import type { NSFWJS } from "nsfwjs/core";
import type { SafetyVerdict } from "../types";

/**
 * Layer 4 safety: an image classifier (NSFWJS, MobileNetV2 "mid") that runs
 * in the browser on every thumbnail before it can be shown. It fails closed:
 * if the model can't load or an image can't be read, nothing is shown.
 */

/** Bump when thresholds or the model change, so cached verdicts get re-checked. */
export const SAFETY_VERSION = 1;

// Deliberately low thresholds. Hiding a fine photo is cheap; showing a bad one is not.
const THRESHOLDS = {
  normal: { Porn: 0.1, Hentai: 0.1, Sexy: 0.2 },
  strict: { Porn: 0.05, Hentai: 0.05, Sexy: 0.1 },
};

let modelPromise: Promise<NSFWJS> | null = null;

/** Starts loading the model (a few MB). Call early, e.g. on page load, so it's warm by the time you press Start. */
export function warmUpSafetyModel(): Promise<NSFWJS> {
  modelPromise ??= (async () => {
    const [{ load }, { MobileNetV2MidModel }, tf] = await Promise.all([
      import("nsfwjs/core"),
      import("nsfwjs/models/mobilenet_v2_mid"),
      import("@tensorflow/tfjs"),
    ]);
    tf.enableProdMode();
    const model = await load("MobileNetV2Mid", { modelDefinitions: [MobileNetV2MidModel], type: "graph" });
    // The first inference compiles WebGL shaders; do it now rather than on the first real image.
    const blank = document.createElement("canvas");
    blank.width = blank.height = 224;
    await model.classify(blank);
    return model;
  })();
  modelPromise.catch(() => {
    modelPromise = null; // allow a retry
  });
  return modelPromise;
}

export function loadImage(url: string, crossOrigin = true): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    const timer = setTimeout(() => reject(new Error("image timed out")), 10_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("image failed to load"));
    };
    img.src = url;
  });
}

export async function classifyImage(thumbUrl: string, strict: boolean): Promise<SafetyVerdict> {
  const model = await warmUpSafetyModel();
  const base = { version: SAFETY_VERSION, checkedAt: Date.now() };
  let img: HTMLImageElement;
  try {
    img = await loadImage(thumbUrl);
  } catch {
    return { ...base, safe: false, reason: "unreadable" };
  }
  let predictions;
  try {
    predictions = await model.classify(img, 5);
  } catch {
    // Usually a tainted canvas (no CORS). We can't check the image, so we don't show it.
    return { ...base, safe: false, reason: "unreadable" };
  }
  const scores: Record<string, number> = {};
  for (const p of predictions) scores[p.className] = Math.round(p.probability * 1000) / 1000;
  return { ...base, ...judge(scores, strict) };
}

export function judge(scores: Record<string, number>, strict: boolean): { safe: boolean; scores: Record<string, number>; reason?: string } {
  const limits = strict ? THRESHOLDS.strict : THRESHOLDS.normal;
  for (const [cls, limit] of Object.entries(limits)) {
    if ((scores[cls] ?? 0) >= limit) return { safe: false, scores, reason: `classifier:${cls}` };
  }
  return { safe: true, scores };
}
