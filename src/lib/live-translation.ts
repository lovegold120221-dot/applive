import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, type Session } from "@google/genai";

export type TranslationStatus = "idle" | "connecting" | "listening" | "playing" | "error";

export type TranslationState = {
  status: TranslationStatus;
  sourceText: string;
  translatedText: string;
  error: string | null;
};

const INITIAL_STATE: TranslationState = {
  status: "idle",
  sourceText: "",
  translatedText: "",
  error: null,
};

function floatToPcm16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function playPcm(bytes: Uint8Array, context: AudioContext, nextTime: { value: number }) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const buffer = context.createBuffer(1, samples.length, 24000);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    channel[index] = samples[index] / 32768;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const startAt = Math.max(context.currentTime + 0.03, nextTime.value);
  source.start(startAt);
  nextTime.value = startAt + buffer.duration;
}

export function useLiveTranslation(stream: MediaStream | null, enabled: boolean, targetLanguageCode: string) {
  const [state, setState] = useState<TranslationState>(INITIAL_STATE);
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef<Session | null>(null);

  const restart = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setState(INITIAL_STATE);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !stream) return;
    const sourceStream = stream;

    let cancelled = false;
    let inputContext: AudioContext | null = null;
    let outputContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    const nextPlaybackTime = { value: 0 };

    async function start() {
      setState({ ...INITIAL_STATE, status: "connecting" });
      try {
        const response = await fetch("/api/translate-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetLanguageCode }),
        });
        const payload = (await response.json()) as { token?: string; model?: string; error?: string };
        if (!response.ok || !payload.token || !payload.model) {
          throw new Error(payload.error ?? "Translation could not start.");
        }

        if (cancelled) return;
        inputContext = new AudioContext({ sampleRate: 16000 });
        outputContext = new AudioContext({ sampleRate: 24000 });
        await Promise.all([inputContext.resume(), outputContext.resume()]);

        const ai = new GoogleGenAI({ apiKey: payload.token, apiVersion: "v1beta" });
        const config = {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode,
            echoTargetLanguage: false,
          },
          sessionResumption: {},
          contextWindowCompression: { slidingWindow: {} },
        };
        const session = await ai.live.connect({
          model: payload.model,
          config,
          callbacks: {
            onopen: () => {
              if (!cancelled) setState((current) => ({ ...current, status: "listening" }));
            },
            onmessage: (message) => {
              const content = message.serverContent;
              if (content?.interrupted) {
                nextPlaybackTime.value = outputContext?.currentTime ?? 0;
              }
              if (content?.inputTranscription?.text) {
                setState((current) => ({ ...current, sourceText: content.inputTranscription?.text ?? "" }));
              }
              if (content?.outputTranscription?.text) {
                setState((current) => ({
                  ...current,
                  translatedText: content.outputTranscription?.text ?? "",
                  status: "playing",
                }));
              }
              for (const part of content?.modelTurn?.parts ?? []) {
                const audio = part.inlineData;
                if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;
                setState((current) => ({ ...current, status: "playing" }));
                if (outputContext) {
                  void playPcm(base64ToBytes(audio.data), outputContext, nextPlaybackTime);
                }
              }
              if (content?.turnComplete) {
                setState((current) => ({ ...current, status: "listening" }));
              }
            },
            onerror: () => {
              if (!cancelled) {
                setState((current) => ({ ...current, status: "error", error: "Translation connection failed." }));
              }
            },
            onclose: () => {
              if (!cancelled) {
                setState((current) => ({ ...current, status: "idle" }));
              }
            },
          },
        });

        if (cancelled) {
          session.close();
          return;
        }
        sessionRef.current = session;
        source = inputContext.createMediaStreamSource(sourceStream);
        processor = inputContext.createScriptProcessor(1024, 1, 1);
        processor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          if (!sessionRef.current) return;
          const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
          sessionRef.current.sendRealtimeInput({
            audio: {
              data: bytesToBase64(pcm),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        };
        source.connect(processor);
        processor.connect(inputContext.destination);
      } catch (error) {
        if (cancelled) return;
        setState({
          ...INITIAL_STATE,
          status: "error",
          error: error instanceof Error ? error.message : "Translation could not start.",
        });
      }
    }

    void start();
    return () => {
      cancelled = true;
      sessionRef.current?.close();
      sessionRef.current = null;
      processor?.disconnect();
      source?.disconnect();
      void inputContext?.close();
      void outputContext?.close();
    };
  }, [attempt, enabled, stream, targetLanguageCode]);

  return { state, restart };
}
