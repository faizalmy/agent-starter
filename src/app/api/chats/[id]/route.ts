import { auth } from "@clerk/nextjs/server";
import { deleteChat } from "@/lib/chat/server/supabaseChatStore";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!id?.trim()) {
    return Response.json({ error: "Missing id" }, { status: 400 });
  }

  try {
    await deleteChat(id, userId);
  } catch (err) {
    // If the chat doesn't exist, treat it as already deleted.
    console.warn("[chats] delete failed:", err);
  }

  return Response.json({ ok: true });
}




