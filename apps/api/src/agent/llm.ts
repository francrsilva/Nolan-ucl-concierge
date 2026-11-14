import OpenAI from "openai";
import type { ChatMessage } from "./stateMachine.js";

/**
 * Thin OpenAI wrapper. Kept deliberately small and transport-agnostic so the
 * same call path backs both the text runtime and (via the shared tool registry)
 * the voice bridge. Streams content tokens through `onToken` while assembling
 * any tool calls, then returns the complete assistant message.
 */

export interface AssembledToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model. */
  arguments: string;
}

export interface AssembledMessage {
  content: string | null;
  toolCalls: AssembledToolCall[];
}

export type OpenAiTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

let client: OpenAI | null = null;
export function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export function model(): string {
  return process.env.AGENT_MODEL?.trim() || "gpt-4o";
}

export async function runChatTurn(
  messages: ChatMessage[],
  tools: OpenAiTool[],
  onToken: (delta: string) => void
): Promise<AssembledMessage> {
  const stream = await getClient().chat.completions.create({
    model: model(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    temperature: 0.2,
    stream: true,
  });

  let content = "";
  const toolAcc = new Map<number, AssembledToolCall>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      content += delta.content;
      onToken(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      toolAcc.set(idx, cur);
    }
  }

  return {
    content: content || null,
    toolCalls: [...toolAcc.values()].filter((t) => t.name),
  };
}
