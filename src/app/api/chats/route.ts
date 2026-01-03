import { auth } from "@clerk/nextjs/server";
import { createChat, listChats } from "@/lib/chat/server/fileChatStore";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const chats = await listChats();
  return Response.json({ chats });
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = await createChat();
  return Response.json({ id }, { status: 201 });
}




