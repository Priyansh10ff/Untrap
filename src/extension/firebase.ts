import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel, type LanguageModelCreateOptions } from "firebase/ai";
import { VERDICT_SCHEMA } from "../core/prompt.ts";

/**
 * Firebase setup shared by the offscreen engine and the welcome page. The config is injected at
 * build time from .env (see .env.example), so no project details live in the repo.
 */

declare const __FIREBASE_CONFIG__: FirebaseOptions | null;
declare const __APPCHECK_DEBUG_TOKEN__: string;
declare const __FIRST_PASS_CLOUD_MODEL__: string;
declare const __SECOND_OPINION_MODEL__: string;

export const firebaseConfigured = Boolean(__FIREBASE_CONFIG__?.apiKey && __FIREBASE_CONFIG__?.appId);

/** Must match between download (welcome page) and use (offscreen), or Chrome treats them as different models. */
export const ON_DEVICE_OPTIONS: LanguageModelCreateOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

let app: FirebaseApp | undefined;

export function firebaseApp(): FirebaseApp | undefined {
  if (!firebaseConfigured) return undefined;
  if (app) return app;
  app = initializeApp(__FIREBASE_CONFIG__!);
  if (__APPCHECK_DEBUG_TOKEN__) {
    // Extensions can't run reCAPTCHA, so the extension proves itself with an App Check debug
    // token injected at build time. The website uses reCAPTCHA Enterprise instead.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = __APPCHECK_DEBUG_TOKEN__;
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => Promise.reject(new Error("Untrap's extension build uses an App Check debug token.")),
      }),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

export interface Models {
  /** First pass: Gemini Nano on the device when it's ready, otherwise Gemini in the cloud. */
  hybrid: GenerativeModel;
  /** Used when the person turned cloud checks off: the device only. */
  deviceOnly: GenerativeModel;
  /** First pass in the cloud, used when Gemini Nano is missing or too slow on this computer. */
  cloudFast: GenerativeModel;
  /** Second opinion for unsure cases: a larger cloud model. */
  cloud: GenerativeModel;
}

let models: Models | undefined;

export function getModels(): Models | undefined {
  const fb = firebaseApp();
  if (!fb) return undefined;
  if (models) return models;
  const ai = getAI(fb, { backend: new GoogleAIBackend() });
  const json = { responseMimeType: "application/json", responseJsonSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>, temperature: 0 };
  const onDeviceParams = { createOptions: ON_DEVICE_OPTIONS, promptOptions: { responseConstraint: VERDICT_SCHEMA } };
  models = {
    hybrid: getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams,
      inCloudParams: { model: __FIRST_PASS_CLOUD_MODEL__, generationConfig: json },
    }),
    deviceOnly: getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams }),
    cloudFast: getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: __FIRST_PASS_CLOUD_MODEL__, generationConfig: json } }),
    cloud: getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: __SECOND_OPINION_MODEL__, generationConfig: json } }),
  };
  return models;
}

type Availability = "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";

/** Whether Gemini Nano is ready on this device. */
export async function onDeviceAvailability(): Promise<Availability> {
  const lm = (globalThis as unknown as { LanguageModel?: { availability(o?: unknown): Promise<string> } }).LanguageModel;
  if (!lm) return "unsupported";
  try {
    return (await lm.availability(ON_DEVICE_OPTIONS)) as Availability;
  } catch {
    return "unavailable";
  }
}
