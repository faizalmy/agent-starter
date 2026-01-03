import "server-only";

import { generateId, type UIMessage } from "ai";
import { PrismaClient, type Prisma } from "@prisma/client";

import { OMITTED_ATTACHMENT_URL } from "@/lib/chat/constants";
import {
  deleteAttachments,
  isStoredAttachmentUrl,
  loadAttachment,
  pathToStoredUrl,
  saveAttachment,
  storedUrlToPath,
} from "./supabaseAttachmentStore";

/**
 * Supabase database chat store with integrated attachment persistence.
 *
 * OVERVIEW:
 * This implements the AI SDK "Chatbot Message Persistence" pattern with
 * Supabase PostgreSQL database and Supabase Storage for attachments:
 * - Chat metadata stored in PostgreSQL `chats` table
 * - Messages stored in PostgreSQL `messages` table (JSONB content)
 * - File attachments stored in Supabase Storage bucket
 * - Uses stored:// references in JSON to link to files
 *
 * DATA FLOW:
 * 1. SAVE: Extract file data from data URLs → save to Storage → store references in database
 * 2. LOAD: Read messages from database → detect stored:// references → generate signed URLs
 * 3. DELETE: Remove chat from database (cascade deletes messages) → delete attachments from Storage
 *
 * USER ISOLATION:
 * All queries filter by userId to ensure users can only access their own chats.
 */

// Prisma Client singleton for serverless environments
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export { OMITTED_ATTACHMENT_URL };

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string; // ISO
};

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Sanitize messages for persistence by extracting and storing file attachments.
 */
async function sanitizeMessagesForPersistence(
  chatId: string,
  userId: string,
  messages: UIMessage[]
): Promise<UIMessage[]> {
  const messagesWithAttachments = await Promise.all(
    messages.map(async (m) => {
      const parts = await Promise.all(
        m.parts.map(async (p) => {
          // Save file attachments to Storage and replace URL with stored:// reference
          if (p.type === "file") {
            // If already stored, keep the reference
            if (typeof p.url === "string" && isStoredAttachmentUrl(p.url)) {
              return p;
            }

            // If omitted, keep it omitted
            if (
              typeof p.url === "string" &&
              (p.url.startsWith("local-storage://omitted") || p.url === OMITTED_ATTACHMENT_URL)
            ) {
              return {
                ...p,
                url: OMITTED_ATTACHMENT_URL,
              };
            }

            // Save new attachment to Storage
            if (typeof p.url === "string" && p.url.startsWith("data:")) {
              const stored = await saveAttachment(chatId, userId, p.url, p.filename, p.mediaType);
              if (stored) {
                return {
                  ...p,
                  url: pathToStoredUrl(stored.path),
                };
              }
            }

            // Fallback: omit if we couldn't save it
            return {
              ...p,
              url: OMITTED_ATTACHMENT_URL,
            };
          }

      // Tool outputs can be very large (page extracts, etc.). Keep persistence robust.
      if (typeof (p as { type?: unknown }).type === "string") {
        const type = (p as { type: string }).type;
        const isToolLike = type === "dynamic-tool" || type.startsWith("tool-");
        if (isToolLike) {
          const next = { ...(p as Record<string, unknown>) };
          for (const key of ["input", "output", "errorText"]) {
            const v = next[key];
            const s = typeof v === "string" ? v : safeJsonStringify(v);
            if (s && s.length > 200_000) {
              next[key] = "[omitted for persistence]";
            }
          }
          return next as typeof p;
        }
      }

          return p;
        })
      );

      return { ...m, parts };
    })
  );

  return messagesWithAttachments;
}

/**
 * Create a new chat for a user.
 */
export async function createChat(userId: string): Promise<string> {
  const id = generateId();
  await prisma.chat.create({
    data: {
      id,
      userId,
      title: null,
    },
  });
  return id;
}

/**
 * Load a chat from database and restore file attachments.
 */
export async function loadChat(id: string, userId: string): Promise<UIMessage[]> {
  try {
    // Verify ownership and load chat with messages
    const chat = await prisma.chat.findFirst({
      where: {
        id,
        userId, // Ownership check
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!chat) {
      // Chat doesn't exist or doesn't belong to user
      return [];
    }

    // Convert database messages to UIMessage format
    const messages: UIMessage[] = chat.messages.map((msg: { content: unknown }) => {
      const content = msg.content as UIMessage;
      return content;
    });

    // Restore attachments from Storage
    const messagesWithAttachments = await Promise.all(
      messages.map(async (m) => {
        const parts = await Promise.all(
          m.parts.map(async (p) => {
            if (p.type === "file" && typeof p.url === "string" && isStoredAttachmentUrl(p.url)) {
              const relativePath = storedUrlToPath(p.url);
              const signedUrl = await loadAttachment(relativePath);

              if (signedUrl) {
                return {
                  ...p,
                  url: signedUrl,
                };
              }

              // If file doesn't exist in Storage, mark as omitted
              return {
                ...p,
                url: OMITTED_ATTACHMENT_URL,
              };
            }

            return p;
          })
        );

        return { ...m, parts };
      })
    );

    return messagesWithAttachments;
  } catch (error) {
    console.error("[supabaseChatStore] Failed to load chat:", error);
    return [];
  }
}

/**
 * Save messages to a chat.
 */
export async function saveChat(opts: {
  id: string;
  userId: string;
  messages: UIMessage[];
}): Promise<void> {
  const sanitized = await sanitizeMessagesForPersistence(opts.id, opts.userId, opts.messages);

  // Extract title from messages
  const title = titleFromMessages(sanitized);

  // Use transaction to ensure consistency
  await prisma.$transaction(async (tx) => {
    // Update or create chat
    await tx.chat.upsert({
      where: { id: opts.id },
      update: {
        title,
        updatedAt: new Date(),
      },
      create: {
        id: opts.id,
        userId: opts.userId,
        title,
      },
    });

    // Delete existing messages
    await tx.message.deleteMany({
      where: { chatId: opts.id },
    });

    // Insert new messages
    if (sanitized.length > 0) {
      await tx.message.createMany({
        data: sanitized.map((msg) => ({
          id: msg.id || generateId(),
          chatId: opts.id,
          role: msg.role,
          content: msg as unknown as Prisma.InputJsonValue,
        })),
      });
    }
  });
}

function titleFromMessages(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type === "text") {
        const t = p.text.trim().replace(/\s+/g, " ");
        if (t.length) return t.length > 60 ? `${t.slice(0, 60)}…` : t;
      }
      if (p.type === "file") {
        const name = (p.filename ?? "").trim();
        if (name) return `Attachment: ${name}`;
        return "Attachment";
      }
    }
  }
  // Avoid showing IDs in the UI; keep this friendly.
  return "New chat";
}

/**
 * List all chats for a user.
 */
export async function listChats(userId: string): Promise<ChatSummary[]> {
  try {
    const chats = await prisma.chat.findMany({
      where: {
        userId, // User isolation
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
          take: 1, // Just to check if chat has messages
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    const summaries: ChatSummary[] = [];

    for (const chat of chats) {
      // Load all messages to generate title (or use chat.title if set)
      const allMessages = await prisma.message.findMany({
        where: { chatId: chat.id },
        orderBy: { createdAt: "asc" },
      });

      const messages: UIMessage[] = allMessages.map((msg: { content: unknown }) => {
        return msg.content as UIMessage;
      });

      // Don't surface empty chats
      if (messages.length === 0) continue;

      const title = chat.title || titleFromMessages(messages);

      summaries.push({
        id: chat.id,
        title,
        updatedAt: chat.updatedAt.toISOString(),
      });
    }

    return summaries;
  } catch (error) {
    console.error("[supabaseChatStore] Failed to list chats:", error);
    return [];
  }
}

/**
 * Delete a chat and all associated attachments.
 */
export async function deleteChat(id: string, userId: string): Promise<void> {
  try {
    // Verify ownership before deletion
    const chat = await prisma.chat.findFirst({
      where: {
        id,
        userId, // Ownership check
      },
    });

    if (!chat) {
      // Chat doesn't exist or doesn't belong to user
      return;
    }

    // Delete chat (cascade deletes messages via foreign key)
    await prisma.chat.delete({
      where: { id },
    });

    // Delete associated attachments from Storage
    await deleteAttachments(id, userId);
  } catch (error) {
    console.error("[supabaseChatStore] Failed to delete chat:", error);
    // Don't throw - treat as already deleted
  }
}
