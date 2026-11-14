import type { TelemetryEvent, Health } from "../types.ts";

/**
 * Consume the agent's SSE stream from a POST /chat request.
 *
 * EventSource only supports GET, so we read the fetch body as a stream and parse
 * SSE frames (`event:` + `data:` separated by a blank line) by hand. Every
 * telemetry event is delivered to `onEvent` as it arrives — this is what powers
 * the live FDE Inspector trace.
 */
export interface ChatResult {
  sessionId: string;
  reply: string;
  state: string;
}

export async function streamChat(
  sessionId: string,
  message: string,
  onEvent: (e: TelemetryEvent) => void
): Promise<ChatResult> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`chat failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ChatResult | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseFrame(frame);
      if (!parsed) continue;

      if (parsed.event === "done") {
        result = JSON.parse(parsed.data) as ChatResult;
      } else if (parsed.event === "error") {
        onEvent({ type: "error", message: (JSON.parse(parsed.data).message as string) ?? "unknown error" });
      } else {
        try {
          onEvent(JSON.parse(parsed.data) as TelemetryEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }

  if (!result) throw new Error("stream ended without a completion frame");
  return result;
}

function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch("/health");
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}
