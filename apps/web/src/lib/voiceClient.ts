import type { TelemetryEvent } from "../types.ts";

/**
 * Browser WebRTC client for the OpenAI Realtime voice path.
 *
 * Flow:
 *  1. POST /voice/session  → ephemeral token + sessionId (session is configured
 *     server-side with the SAME tool catalogue + guardrails as text).
 *  2. Open an RTCPeerConnection: publish mic, play back the model's audio,
 *     and open the "oai-events" data channel for events.
 *  3. When the model requests a function call, forward it to POST /voice/tool,
 *     which runs it through the deterministic guardrail gate, then return the
 *     result over the data channel. Guardrail/tool telemetry is surfaced to the
 *     same FDE Inspector.
 */

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "error" | "closed";

export interface VoiceHandlers {
  onStatus: (s: VoiceStatus, detail?: string) => void;
  onUserTranscript: (text: string) => void;
  onAssistantDelta: (delta: string) => void;
  onAssistantDone: (text: string) => void;
  onTelemetry: (events: TelemetryEvent[], state?: string) => void;
  onError: (msg: string) => void;
}

interface RealtimeServerEvent {
  type: string;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  error?: { message?: string };
}

export class VoiceClient {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private stream?: MediaStream;
  private audioEl?: HTMLAudioElement;
  sessionId = "";

  constructor(private h: VoiceHandlers) {}

  async start(): Promise<void> {
    this.h.onStatus("connecting");

    // 1. Mint an ephemeral Realtime session (configured server-side).
    const res = await fetch("/voice/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) throw new Error(`voice/session failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    const data = (await res.json()) as { sessionId: string; value: string; model: string; error?: string };
    if (data.error) throw new Error(data.error);
    this.sessionId = data.sessionId;
    const ephemeral = data.value;
    if (!ephemeral) throw new Error("no ephemeral token returned");

    // 2. Peer connection: remote audio + mic + data channel.
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audioEl = new Audio();
    audioEl.autoplay = true;
    this.audioEl = audioEl;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0] ?? null;
    };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onopen = () => this.h.onStatus("listening");
    dc.onmessage = (e) => {
      try {
        void this.onServerEvent(JSON.parse(e.data) as RealtimeServerEvent);
      } catch {
        /* ignore non-JSON frames */
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.h.onStatus("error", pc.connectionState);
    };

    // 3. SDP offer/answer with the GA Realtime calls endpoint, authed by the ephemeral key.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp ?? "",
      headers: { Authorization: `Bearer ${ephemeral}`, "Content-Type": "application/sdp" },
    });
    if (!sdpRes.ok) throw new Error(`realtime SDP exchange failed (${sdpRes.status}): ${await sdpRes.text().catch(() => "")}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
  }

  private async onServerEvent(ev: RealtimeServerEvent): Promise<void> {
    const t = ev.type;
    if (t === "input_audio_buffer.speech_started") return this.h.onStatus("listening");
    if (t === "response.created") return this.h.onStatus("speaking");
    if (t.endsWith("input_audio_transcription.completed")) {
      if (ev.transcript) this.h.onUserTranscript(ev.transcript.trim());
      return;
    }
    if (t.includes("audio_transcript.delta")) {
      if (ev.delta) this.h.onAssistantDelta(ev.delta);
      return;
    }
    if (t.includes("audio_transcript.done")) {
      if (ev.transcript) this.h.onAssistantDone(ev.transcript.trim());
      this.h.onStatus("listening");
      return;
    }
    if (t === "response.function_call_arguments.done") {
      await this.handleFunctionCall({ name: ev.name, call_id: ev.call_id, arguments: ev.arguments });
      return;
    }
    if (t === "response.output_item.done" && ev.item?.type === "function_call") {
      await this.handleFunctionCall({ name: ev.item.name, call_id: ev.item.call_id, arguments: ev.item.arguments });
      return;
    }
    if (t === "error") this.h.onError(ev.error?.message ?? "realtime error");
  }

  private async handleFunctionCall(call: { name?: string; call_id?: string; arguments?: string }): Promise<void> {
    if (!call.name || !call.call_id) return;
    let args: unknown = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      /* leave empty */
    }
    try {
      const res = await fetch("/voice/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, name: call.name, arguments: args }),
      });
      const data = (await res.json()) as { result: unknown; telemetry: TelemetryEvent[]; state?: string };
      this.h.onTelemetry(data.telemetry ?? [], data.state);
      // Return the tool result to the model, then let it continue speaking.
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(data.result) } });
      this.send({ type: "response.create" });
    } catch (err) {
      this.h.onError(err instanceof Error ? err.message : String(err));
    }
  }

  private send(obj: unknown): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(obj));
  }

  stop(): void {
    try {
      this.dc?.close();
      this.pc?.close();
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.audioEl) this.audioEl.srcObject = null;
    } finally {
      this.h.onStatus("closed");
    }
  }
}
