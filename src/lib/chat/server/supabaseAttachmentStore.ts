import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// ============================================================================
// CONFIGURATION
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "attachments";

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    "[supabaseAttachmentStore] Missing Supabase configuration. Attachment storage will fail."
  );
}

// Initialize Supabase client with service key for admin operations
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

// ============================================================================
// OVERVIEW
// ============================================================================

/**
 * Supabase Storage attachment storage for production.
 *
 * This stores file attachments in Supabase Storage buckets with user-scoped
 * organization and secure access via signed URLs.
 *
 * DIRECTORY STRUCTURE:
 * {userId}/{chatId}/{hash}.{ext}
 *
 * URL SCHEMES:
 * - data:image/png;base64,... → Actual file data (client-side, in-memory)
 * - stored://attachments/{userId}/{chatId}/{file} → Reference to stored file (persisted JSON)
 * - omitted://attachment → File was stripped (fallback)
 */

// ============================================================================
// TYPES
// ============================================================================

export interface StoredAttachment {
  /** Relative path to the stored file (e.g., "attachments/userId/chatId/file_hash.pdf") */
  path: string;
  /** Original filename provided by user */
  filename: string;
  /** MIME type (e.g., "image/png", "application/pdf") */
  mediaType: string;
  /** File size in bytes */
  size: number;
}

// ============================================================================
// INTERNAL UTILITIES
// ============================================================================

/**
 * Extract file extension from filename or mediaType.
 */
function getFileExtension(filename: string | undefined, mediaType: string | undefined): string {
  // Try to get extension from filename
  if (filename?.includes(".")) {
    const parts = filename.split(".");
    return parts[parts.length - 1] || "bin";
  }

  // Fall back to mediaType
  if (mediaType) {
    const typeMap: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "application/pdf": "pdf",
      "text/plain": "txt",
      "text/html": "html",
      "text/markdown": "md",
      "application/json": "json",
    };
    return typeMap[mediaType] || "bin";
  }

  return "bin";
}

/**
 * Convert a data URL to a Buffer.
 */
function dataUrlToBuffer(dataUrl: string): Buffer | null {
  try {
    // Data URL format: data:[<mediatype>][;base64],<data>
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex === -1) return null;

    const header = dataUrl.substring(0, commaIndex);
    if (!header.startsWith("data:") || !header.includes("base64")) return null;

    const base64Data = dataUrl.substring(commaIndex + 1);
    if (!base64Data) return null;

    return Buffer.from(base64Data, "base64");
  } catch (error) {
    console.error("[supabaseAttachmentStore] Failed to convert data URL to buffer:", error);
    return null;
  }
}

// ============================================================================
// PUBLIC API - STORAGE OPERATIONS
// ============================================================================

/**
 * Save a file attachment to Supabase Storage and return metadata.
 */
export async function saveAttachment(
  chatId: string,
  userId: string,
  fileUrl: string,
  filename: string | undefined,
  mediaType: string | undefined
): Promise<StoredAttachment | null> {
  if (!supabase) {
    console.error("[supabaseAttachmentStore] Supabase client not initialized");
    return null;
  }

  try {
    // Only handle data URLs for now
    if (!fileUrl.startsWith("data:")) {
      return null;
    }

    const buffer = dataUrlToBuffer(fileUrl);
    if (!buffer) {
      return null;
    }

    // Generate a hash-based filename to avoid collisions
    const hash = createHash("sha256").update(buffer).digest("hex").substring(0, 16);
    const ext = getFileExtension(filename, mediaType);
    const storedFilename = `${hash}.${ext}`;

    // Storage path: {userId}/{chatId}/{filename}
    const storagePath = `${userId}/${chatId}/${storedFilename}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, buffer, {
        contentType: mediaType || "application/octet-stream",
        upsert: true, // Overwrite if exists (same hash = same file)
      });

    if (uploadError) {
      console.error("[supabaseAttachmentStore] Failed to upload attachment:", uploadError);
      return null;
    }

    // Return metadata with path format matching stored:// URL scheme
    const relativePath = `attachments/${storagePath}`;
    return {
      path: relativePath,
      filename: filename || storedFilename,
      mediaType: mediaType || "application/octet-stream",
      size: buffer.length,
    };
  } catch (error) {
    console.error("[supabaseAttachmentStore] Failed to save attachment:", filename, error);
    return null;
  }
}

/**
 * Load an attachment from Supabase Storage and return a signed URL.
 */
export async function loadAttachment(relativePath: string): Promise<string | null> {
  if (!supabase) {
    console.error("[supabaseAttachmentStore] Supabase client not initialized");
    return null;
  }

  try {
    // Extract storage path from relative path (remove "attachments/" prefix if present)
    const storagePath = relativePath.startsWith("attachments/")
      ? relativePath.replace("attachments/", "")
      : relativePath;

    // Generate signed URL (valid for 1 hour)
    const { data, error } = await supabase.storage.from(storageBucket).createSignedUrl(storagePath, 3600);

    if (error || !data) {
      console.error("[supabaseAttachmentStore] Failed to generate signed URL:", error);
      return null;
    }

    return data.signedUrl;
  } catch (error) {
    console.error("[supabaseAttachmentStore] Failed to load attachment:", error);
    return null;
  }
}

/**
 * Delete all attachments for a chat from Supabase Storage.
 */
export async function deleteAttachments(chatId: string, userId: string): Promise<void> {
  if (!supabase) {
    console.error("[supabaseAttachmentStore] Supabase client not initialized");
    return;
  }

  try {
    // List all files in the chat's directory
    const prefix = `${userId}/${chatId}/`;
    const { data: files, error: listError } = await supabase.storage
      .from(storageBucket)
      .list(prefix, {
        limit: 1000,
        sortBy: { column: "name", order: "asc" },
      });

    if (listError) {
      console.error("[supabaseAttachmentStore] Failed to list attachments:", listError);
      return;
    }

    if (!files || files.length === 0) {
      return;
    }

    // Delete all files
    const filePaths = files.map((file) => `${prefix}${file.name}`);
    const { error: deleteError } = await supabase.storage.from(storageBucket).remove(filePaths);

    if (deleteError) {
      console.error("[supabaseAttachmentStore] Failed to delete attachments:", deleteError);
    }
  } catch (error) {
    console.error("[supabaseAttachmentStore] Failed to delete attachments:", error);
  }
}

// ============================================================================
// PUBLIC API - URL UTILITIES
// ============================================================================

/**
 * Check if a URL is a stored attachment reference.
 */
export function isStoredAttachmentUrl(url: string): boolean {
  return url.startsWith("stored://attachments/");
}

/**
 * Convert a stored attachment URL to a relative path.
 *
 * Example: stored://attachments/userId/chatId/file.ext -> attachments/userId/chatId/file.ext
 */
export function storedUrlToPath(url: string): string {
  return url.replace("stored://", "");
}

/**
 * Convert a relative path to a stored attachment URL.
 *
 * Example: attachments/userId/chatId/file.ext -> stored://attachments/userId/chatId/file.ext
 */
export function pathToStoredUrl(path: string): string {
  return `stored://${path}`;
}
