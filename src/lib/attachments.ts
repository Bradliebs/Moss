// src/lib/attachments.ts
//
// Pure helpers for chat attachments: validating picked files before they become
// data-URL image attachments, and a heuristic for whether the selected model is
// likely to accept images. Kept dependency-free and DOM-free so they unit-test
// in the node environment.

/** Maximum size for an inline image attachment. base64 data URLs inflate the
 *  payload by ~33% and providers reject oversized requests, so cap before
 *  encoding rather than after. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Maximum size for a text file inlined into the prompt as a fenced block.
 *  A large dump silently bloats the context window and provider request, so
 *  reject before reading rather than after. */
export const MAX_TEXT_BYTES = 256 * 1024;

/** Validate a picked file destined to become an image attachment. Returns a
 *  short error string to show the user, or null when the file is acceptable.
 *  Drag-drop and paste bypass the file picker's accept filter, so this guards
 *  against non-image and oversized files reaching the providers. */
export function imageAttachmentError(file: { type: string; size: number; name: string }): string | null {
  if (!file.type.startsWith("image/")) return `${file.name}: not an image`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: image is larger than 10 MB`;
  return null;
}

/** Validate a picked file destined to be inlined as text. Returns a short error
 *  string to show the user, or null when the file is acceptable. */
export function textAttachmentError(file: { size: number; name: string }): string | null {
  if (file.size > MAX_TEXT_BYTES) return `${file.name}: text file is larger than 256 KB`;
  return null;
}

/** Substrings of model ids known to be vision-capable, matched case-insensitively.
 *  Data-driven so a new model is a one-line addition. Provider kind is deliberately
 *  not a key: vision support is a property of the model, not the endpoint serving
 *  it, so a model name alone determines the answer. */
export const VISION_MODEL_MARKERS: readonly string[] = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-4-vision",
  "o3",
  "o4",
  "claude-3",
  "claude-4",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini",
  "llava",
  "llama-3.2",
  "llama3.2",
  "llama-4",
  "llama4",
  "pixtral",
  "moondream",
  "minicpm-v",
  "qwen2-vl",
  "qwen2.5-vl",
  "vision",
];

/** Heuristic: does the model name look vision-capable? Used only to show an
 *  advisory warning when images are attached, never to block sending. The marker
 *  list is necessarily incomplete, so a false negative just shows a dismissible
 *  hint rather than preventing the request. */
export function isLikelyVisionModel(model: string): boolean {
  const m = model.toLowerCase();
  return VISION_MODEL_MARKERS.some((marker) => m.includes(marker));
}
