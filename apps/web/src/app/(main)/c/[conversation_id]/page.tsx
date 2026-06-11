// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConversationView } from "@/components/conversation/ConversationView";

/**
 * Conversation screen (`docs/014 §4`).
 *
 * Server component: extracts the dynamic segment and mounts the
 * client-side view that owns history loading, the streaming
 * transcript, and the composer (`docs/014 §11.2` — server components
 * by default, client components for interaction).
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversation_id: string }>;
}): Promise<React.ReactElement> {
  const { conversation_id: conversationId } = await params;
  return <ConversationView conversationId={conversationId} />;
}
