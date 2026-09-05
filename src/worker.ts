import { createInflectInference } from "./port/inference.mjs";

type InitMessage = {
	type: "init";
	models: Record<"duration.onnx" | "decode.onnx", ArrayBuffer>;
	wasmPaths: { mjs: string; wasm: string };
};
type SynthesizeMessage = {
	type: "synthesize";
	id: number;
	text: string;
	speed: number;
	variation: number;
	seed: number;
	markdownNormalization: "default" | "none" | "custom";
	markdownRules: {
		headings: boolean;
		emphasis: boolean;
		links: boolean;
		listsAndQuotes: boolean;
		code: boolean;
		strikethroughAndRules: boolean;
	};
};
type AbortMessage = { type: "abort"; id: number };

let inference: Awaited<ReturnType<typeof createInflectInference>> | null = null;
const controllers = new Map<number, AbortController>();

self.onmessage = (event: MessageEvent<InitMessage | SynthesizeMessage | AbortMessage>) => {
	void handleMessage(event.data);
};

let activeTask: Promise<void> | null = null;

async function handleMessage(message: InitMessage | SynthesizeMessage | AbortMessage): Promise<void> {
	if (message.type === "abort") {
		controllers.get(message.id)?.abort();
		return;
	}
	if (message.type === "init") {
		try {
			inference = await createInflectInference({
				loadModel: async (name: "duration.onnx" | "decode.onnx") => message.models[name],
				wasmPaths: message.wasmPaths as unknown as string,
			});
			post({ type: "ready" });
		} catch (error) {
			post({ type: "init-error", message: errorMessage(error) });
		}
		return;
	}
	if (!inference) {
		post({ type: "error", id: message.id, message: "Speech worker is not initialized." });
		return;
	}

	// Abort any active synthesis so ONNX sessions are never run concurrently
	for (const controller of controllers.values()) {
		controller.abort();
	}
	if (activeTask) {
		try {
			await activeTask;
		} catch {
			// ignore previous abort
		}
	}

	const controller = new AbortController();
	controllers.set(message.id, controller);

	const task = (async () => {
		try {
			await (inference.synthesize as (text: string, options: Record<string, unknown>) => Promise<unknown>)(message.text, {
				speed: message.speed,
				variation: message.variation,
				seed: message.seed,
				markdownNormalization: message.markdownNormalization,
				markdownRules: message.markdownRules,
				signal: controller.signal,
				onChunk: async (chunk: { waveform: Float32Array; source: string }) => {
					if (controller.signal.aborted) return;
					post(
						{ type: "chunk", id: message.id, waveform: chunk.waveform, source: chunk.source },
						[chunk.waveform.buffer as ArrayBuffer],
					);
				},
			});
			if (!controller.signal.aborted) {
				post({ type: "complete", id: message.id });
			} else {
				post({ type: "error", id: message.id, message: "Synthesis aborted." });
			}
		} catch (error) {
			post({ type: "error", id: message.id, message: errorMessage(error) });
		} finally {
			controllers.delete(message.id);
		}
	})();

	activeTask = task;
	try {
		await task;
	} finally {
		if (activeTask === task) {
			activeTask = null;
		}
	}
}

function post(message: unknown, transfer?: Transferable[]): void {
	(self as unknown as { postMessage(data: unknown, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
