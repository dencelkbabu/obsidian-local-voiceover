import { splitText, stripMarkdown } from "./port/frontend.mjs";
import type { LocalVoiceoverSettings } from "./settings";

export interface VoiceInfo {
	name: string;
	lang: string;
	voiceURI: string;
	isDefault: boolean;
}

export class WebSpeechPlayer {
	private activeUtterances = new Set<SpeechSynthesisUtterance>();
	private currentAbort: AbortController | null = null;
	private onStateChange: () => void = () => undefined;
	private onChunkStart: (source: string) => void = () => undefined;
	private active = false;

	get isPlaying(): boolean {
		return this.active;
	}

	setOnStateChange(callback: () => void): void {
		this.onStateChange = callback;
	}

	setOnChunkStart(callback: (source: string) => void): void {
		this.onChunkStart = callback;
	}

	static isSupported(): boolean {
		return typeof window !== "undefined" && "speechSynthesis" in window;
	}

	static getAvailableVoices(): Promise<VoiceInfo[]> {
		if (!this.isSupported()) return Promise.resolve([]);

		const mapVoices = (voices: SpeechSynthesisVoice[]): VoiceInfo[] =>
			voices.map((v) => ({
				name: v.name,
				lang: v.lang,
				voiceURI: v.voiceURI,
				isDefault: v.default,
			}));

		const voices = window.speechSynthesis.getVoices();
		if (voices.length > 0) {
			return Promise.resolve(mapVoices(voices));
		}

		return new Promise((resolve) => {
			let resolved = false;
			const handler = () => {
				if (resolved) return;
				resolved = true;
				window.speechSynthesis.removeEventListener("voiceschanged", handler);
				resolve(mapVoices(window.speechSynthesis.getVoices()));
			};

			window.speechSynthesis.addEventListener("voiceschanged", handler);
			// Fallback timeout in case voiceschanged never fires (e.g. empty voices)
			window.setTimeout(() => {
				if (!resolved) {
					resolved = true;
					window.speechSynthesis.removeEventListener("voiceschanged", handler);
					resolve(mapVoices(window.speechSynthesis.getVoices()));
				}
			}, 500);
		});
	}

	private findVoice(voiceURI: string): SpeechSynthesisVoice | null {
		if (!WebSpeechPlayer.isSupported()) return null;
		const voices = window.speechSynthesis.getVoices();
		if (voiceURI) {
			const matched = voices.find((v) => v.voiceURI === voiceURI || v.name === voiceURI);
			if (matched) return matched;
		}
		return voices.find((v) => v.default) ?? voices[0] ?? null;
	}

	async speak(
		rawText: string,
		settings: LocalVoiceoverSettings,
		signal?: AbortSignal,
	): Promise<void> {
		if (!WebSpeechPlayer.isSupported()) {
			throw new Error("Web Speech API is not supported in this environment.");
		}

		this.stop();

		const abort = new AbortController();
		this.currentAbort = abort;
		signal?.addEventListener("abort", () => this.stop());

		const defaultRules = {
			headings: true,
			emphasis: true,
			links: true,
			listsAndQuotes: true,
			code: true,
			strikethroughAndRules: true,
		};
		const rules =
			settings.markdownNormalization === "custom"
				? { ...defaultRules, ...settings.markdownRules }
				: defaultRules;

		const stripMarkdownFn = stripMarkdown as (input: string, rules: Record<string, boolean>) => string;
		const splitTextFn = splitText as (text: string) => string[];

		const preparedText: string =
			settings.markdownNormalization === "none"
				? rawText
				: stripMarkdownFn(rawText, rules);

		const rawChunks: string[] = splitTextFn(preparedText);
		const chunks: string[] = rawChunks.filter((c: string) => c.trim().length > 0);
		if (chunks.length === 0) return;

		this.active = true;
		this.onStateChange();

		const targetVoice = this.findVoice(settings.systemVoiceURI);

		try {
			for (let i = 0; i < chunks.length; i++) {
				if (abort.signal.aborted || signal?.aborted) break;

				const chunk: string = chunks[i];
				await this.speakChunk(chunk, targetVoice, settings.speed, settings.systemPitch, abort.signal);
			}
		} finally {
			if (this.currentAbort === abort) {
				this.currentAbort = null;
			}
			this.active = false;
			this.onStateChange();
		}
	}

	private speakChunk(
		chunk: string,
		voice: SpeechSynthesisVoice | null,
		rate: number,
		pitch: number,
		abortSignal: AbortSignal,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			if (abortSignal.aborted) {
				resolve();
				return;
			}

			const utterance = new SpeechSynthesisUtterance(chunk);
			if (voice) utterance.voice = voice;
			utterance.rate = Math.min(2, Math.max(0.5, rate));
			utterance.pitch = Math.min(1.5, Math.max(0.5, pitch));

			this.activeUtterances.add(utterance);

			let cleanup = () => {
				this.activeUtterances.delete(utterance);
				abortSignal.removeEventListener("abort", onAbort);
			};

			const onAbort = () => {
				cleanup();
				window.speechSynthesis.cancel();
				resolve();
			};

			utterance.onstart = () => {
				if (abortSignal.aborted) {
					window.speechSynthesis.cancel();
					cleanup();
					resolve();
					return;
				}
				this.onChunkStart(chunk);
			};

			utterance.onend = () => {
				cleanup();
				resolve();
			};

			utterance.onerror = (event) => {
				cleanup();
				// 'canceled' or 'interrupted' is expected when user clicks stop
				if (event.error === "canceled" || event.error === "interrupted") {
					resolve();
				} else {
					reject(new Error(`Speech synthesis failed: ${event.error}`));
				}
			};

			abortSignal.addEventListener("abort", onAbort);
			window.speechSynthesis.speak(utterance);
		});
	}

	stop(): void {
		if (this.currentAbort) {
			this.currentAbort.abort();
			this.currentAbort = null;
		}
		if (WebSpeechPlayer.isSupported()) {
			window.speechSynthesis.cancel();
		}
		this.activeUtterances.clear();
		if (this.active) {
			this.active = false;
			this.onStateChange();
		}
	}
}
