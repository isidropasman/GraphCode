import type { VoiceStatus } from "@graphcode/protocol";

export interface TranscriptionProvider {
  readonly id: string;
  status(): VoiceStatus;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/**
 * OpenAI speech-to-text. Audio is captured only on explicit push-to-talk in the GUI and
 * sent here; the key is read from the runtime environment and never sent to the GUI.
 */
export class OpenAITranscription implements TranscriptionProvider {
  readonly id = "openai";
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string = process.env.GRAPHCODE_STT_MODEL ?? "gpt-4o-mini-transcribe",
    private readonly baseUrl: string = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ) {}

  status(): VoiceStatus {
    return this.apiKey
      ? { provider: `openai:${this.model}`, configured: true, reason: null }
      : { provider: "openai", configured: false, reason: "Set OPENAI_API_KEY in the runtime environment to enable speech-to-text." };
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (!this.apiKey) throw new Error(this.status().reason!);
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("wav") ? "wav" : "webm";
    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { text?: string };
    if (typeof body.text !== "string") throw new Error("Transcription response had no text");
    return body.text.trim();
  }
}
