import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import { env } from "@huggingface/transformers";

// Configure ONNX wasm backend for browser Web Worker execution
if (env.backends.onnx.wasm) {
	env.backends.onnx.wasm.numThreads = 1;
	env.backends.onnx.wasm.proxy = false;
}

let ttsInstance: KokoroTTS | null = null;
let currentDtype: "q8" | "fp32" | null = null;
let initPromise: Promise<KokoroTTS> | null = null;
let activeJobId: number | null = null;
let activeJobAborted = false;

interface InitMessage {
	type: "init";
	dtype: "q8" | "fp32";
}

interface SynthesizeMessage {
	type: "synthesize";
	id: number;
	text: string;
	voice: string;
	speed: number;
	dtype: "q8" | "fp32";
}

interface AbortMessage {
	type: "abort";
	id: number;
}

type WorkerMessage = InitMessage | SynthesizeMessage | AbortMessage;

function post(message: unknown, transfer?: Transferable[]): void {
	(self as unknown as { postMessage(data: unknown, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

async function getOrInitTTS(dtype: "q8" | "fp32"): Promise<KokoroTTS> {
	if (ttsInstance && currentDtype === dtype) {
		return ttsInstance;
	}
	if (initPromise && currentDtype === dtype) {
		return initPromise;
	}

	currentDtype = dtype;
	initPromise = (async () => {
		const progress_callback = (progress: unknown) => {
			post({
				type: "progress",
				data: progress,
			});
		};

		const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
			dtype,
			device: "wasm",
			progress_callback,
		});

		ttsInstance = tts;
		return tts;
	})();

	try {
		return await initPromise;
	} catch (err) {
		initPromise = null;
		ttsInstance = null;
		currentDtype = null;
		throw err;
	}
}

async function handleMessage(message: WorkerMessage): Promise<void> {
	if (message.type === "init") {
		try {
			await getOrInitTTS(message.dtype);
			post({ type: "ready" });
		} catch (error) {
			const errMessage = error instanceof Error ? error.message : String(error);
			post({ type: "init-error", message: errMessage });
		}
		return;
	}

	if (message.type === "abort") {
		if (activeJobId === message.id) {
			activeJobAborted = true;
		}
		return;
	}

	if (message.type === "synthesize") {
		const { id, text, voice, speed, dtype } = message;
		activeJobId = id;
		activeJobAborted = false;

		try {
			const tts = await getOrInitTTS(dtype);

			const splitter = new TextSplitterStream();
			splitter.push(text);
			splitter.close();

			for await (const chunk of tts.stream(splitter, { voice: voice as never, speed })) {
				if (activeJobId !== id || activeJobAborted) {
					break;
				}

				const waveform = chunk.audio.audio;
				post(
					{
						type: "chunk",
						id,
						waveform,
						source: chunk.text,
					},
					[waveform.buffer],
				);
			}

			if (activeJobId === id && !activeJobAborted) {
				post({ type: "complete", id });
			}
		} catch (error) {
			if (activeJobId === id && !activeJobAborted) {
				const errMessage = error instanceof Error ? error.message : String(error);
				post({ type: "error", id, message: errMessage });
			}
		} finally {
			if (activeJobId === id) {
				activeJobId = null;
				activeJobAborted = false;
			}
		}
	}
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
	void handleMessage(event.data);
};
