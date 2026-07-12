const AVATAR_SIZE = 256;
const MAX_AVATAR_INPUT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function avatarFileError(file: Pick<File, "name" | "size" | "type">): string | null {
  if (!SUPPORTED_AVATAR_TYPES.has(file.type)) return `${file.name}: choose a PNG, JPG, or WebP image`;
  if (file.size > MAX_AVATAR_INPUT_BYTES) return `${file.name}: image is larger than 10 MB`;
  return null;
}

export async function createAvatarDataUrl(file: File): Promise<string> {
  const error = avatarFileError(file);
  if (error) throw new Error(error);

  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image");

    const scale = Math.max(AVATAR_SIZE / image.width, AVATAR_SIZE / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (AVATAR_SIZE - width) / 2, (AVATAR_SIZE - height) / 2, width, height);
    return canvas.toDataURL("image/webp", 0.9);
  } finally {
    image.close();
  }
}