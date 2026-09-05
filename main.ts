import { Editor, MarkdownView, Notice, Plugin, normalizePath } from "obsidian";
import { ModelCache } from "./src/modelCache";
import { StreamPlayer } from "./src/player";
import { WebSpeechPlayer } from "./src/webSpeechPlayer";
import { boundaryPauseSeconds, edgeFade } from "./src/port/runtime.mjs";
import { createSelectionToolbarExtension, playbackHighlightExtension, type VoiceoverState } from "./src/selectionToolbar";
import { DEFAULT_SETTINGS, normalizeSpeechSettings, type LocalVoiceoverSettings } from "./src/settings";
import { LocalVoiceoverSettingTab } from "./src/settingsTab";
import workerSource from "./src/generatedWorker";
import { SpeechWorkerClient } from "./src/workerClient";

export default class LocalVoiceoverPlugin extends Plugin {
	settings: LocalVoiceoverSettings = DEFAULT_SETTINGS;
	private readonly player = new StreamPlayer();
	private readonly webPlayer = new WebSpeechPlayer();
	private abortController: AbortController | null = null;
	private worker: SpeechWorkerClient | null = null;
	private loading: Promise<SpeechWorkerClient> | null = null;
	private state: VoiceoverState = "idle";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.player.setOnStateChange(() => this.syncPlaybackState());
		this.webPlayer.setOnStateChange(() => this.syncPlaybackState());
		this.webPlayer.setOnChunkStart((source) => {
			if (this.settings.highlightSpokenText) {
				window.dispatchEvent(new CustomEvent("local-voiceover-highlight", { detail: { source } }));
			}
		});

		this.addSettingTab(new LocalVoiceoverSettingTab(this.app, this));
		this.registerEditorExtension([
			playbackHighlightExtension,
			createSelectionToolbarExtension({
				getState: () => this.state,
				isHighlightEnabled: () => this.settings.highlightSpokenText,
				speak: (text) => void this.speak(text),
				stop: () => this.stop(),
			}),
		]);

		this.addRibbonIcon("volume-2", "Local voiceover: Speak / stop", () => {
			if (this.isBusy()) {
				this.stop();
			} else {
				const context = this.getActiveNoteContext();
				if (context) {
					if (context.isEntireNote) {
						new Notice("Local voiceover: Speaking entire note…");
					}
					void this.speak(context.text, context.from);
				} else {
					new Notice("Local voiceover: No active note or selection to speak.");
				}
			}
		});

		this.addCommand({
			id: "speak-note-or-selection",
			name: "Speak note or selection",
			checkCallback: (checking) => {
				const context = this.getActiveNoteContext();
				if (!context || this.isBusy()) return false;
				if (!checking) {
					if (context.isEntireNote) {
						new Notice("Local voiceover: Speaking entire note…");
					}
					void this.speak(context.text, context.from);
				}
				return true;
			},
		});

		this.addCommand({
			id: "speak-entire-note",
			name: "Speak entire note",
			checkCallback: (checking) => {
				const fullText = this.getEntireNoteText();
				if (!fullText || this.isBusy()) return false;
				if (!checking) {
					new Notice("Local voiceover: Speaking entire note…");
					void this.speak(fullText, 0);
				}
				return true;
			},
		});

		this.addCommand({
			id: "speak-selected-text",
			name: "Speak selected text",
			editorCheckCallback: (checking, editor) => this.speakCommand(checking, editor),
		});

		this.addCommand({
			id: "stop-speaking",
			name: "Stop speaking",
			checkCallback: (checking) => {
				if (!this.isBusy()) return false;
				if (!checking) this.stop();
				return true;
			},
		});

		this.register(() => this.disposeRuntime());
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<LocalVoiceoverSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		if (!WebSpeechPlayer.isSupported() && this.settings.ttsEngine === "system") {
			this.settings.ttsEngine = "inflect";
		}
		normalizeSpeechSettings(this.settings);
	}

	getActiveEngine(): "system" | "inflect" {
		if (this.settings.ttsEngine === "system" && !WebSpeechPlayer.isSupported()) {
			return "inflect";
		}
		return this.settings.ttsEngine;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	clearHighlight(): void {
		window.dispatchEvent(new Event("local-voiceover-highlight-clear"));
	}

	private unlockPlaybackRange(): void {
		window.dispatchEvent(new Event("local-voiceover-range-unlock"));
	}

	private getActiveNoteContext(): { text: string; from: number; isEntireNote: boolean } | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return null;

		// 1. Check if user has selected text in editor (Editing View)
		if (activeView.editor) {
			const selection = activeView.editor.getSelection().trim();
			if (selection) {
				const fromOffset = activeView.editor.posToOffset(activeView.editor.getCursor("from"));
				return { text: selection, from: fromOffset, isEntireNote: false };
			}
		}

		// 2. Check if user has highlighted text on screen in Reading View (DOM Selection)
		const domWin = activeView.containerEl.win ?? window;
		const domSelection = domWin.getSelection()?.toString()?.trim();
		if (domSelection) {
			return { text: domSelection, from: 0, isEntireNote: false };
		}

		// 3. Fallback: Retrieve the full note content for full-page voiceover
		const fullText = (activeView.getViewData?.() ?? activeView.editor?.getValue?.() ?? "").trim();
		if (fullText) {
			return { text: fullText, from: 0, isEntireNote: true };
		}

		return null;
	}

	private getEntireNoteText(): string | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return null;
		const fullText = (activeView.getViewData?.() ?? activeView.editor?.getValue?.() ?? "").trim();
		return fullText || null;
	}

	private speakCommand(checking: boolean, editor: Editor): boolean {
		const text = editor.getSelection().trim();
		if (!text || this.isBusy()) return false;
		if (!checking) {
			const fromOffset = editor.posToOffset(editor.getCursor("from"));
			window.setTimeout(() => void this.speak(text, fromOffset), 0);
		}
		return true;
	}

	private async speak(text: string, from = 0): Promise<void> {
		if (!text || this.isBusy()) return;
		const abort = new AbortController();
		this.abortController = abort;
		this.clearHighlight();
		this.unlockPlaybackRange();
		window.dispatchEvent(new CustomEvent("local-voiceover-playback-start", { detail: { text, from } }));

		if (this.getActiveEngine() === "system") {
			this.setState("speaking");
			try {
				await this.webPlayer.speak(text, this.settings, abort.signal);
			} catch (error) {
				if (!abort.signal.aborted) {
					console.error("Local Voiceover system synthesis failed", error);
					const message = error instanceof Error ? error.message : "Unknown synthesis error.";
					new Notice(`Local Voiceover: ${message}`);
				}
			} finally {
				if (this.abortController === abort) this.abortController = null;
				this.syncPlaybackState();
			}
			return;
		}

		// Inflect Micro v2 synthesis
		this.setState("loading");
		try {
			await this.player.start();
			const worker = await this.getWorker();
			if (abort.signal.aborted) return;
			this.setState("generating");
			new Notice("Generating local speech…");
			const pendingChunks: Array<{ waveform: Float32Array; source: string }> = [];
			const enqueueChunk = (chunk: { waveform: Float32Array; source: string }) => {
				this.setState("speaking");
				this.player.queue(
					edgeFade(chunk.waveform) as Float32Array,
					Number(boundaryPauseSeconds(chunk.source)),
					() => {
						if (this.settings.highlightSpokenText)
							window.dispatchEvent(new CustomEvent("local-voiceover-highlight", { detail: { source: chunk.source } }));
					},
				);
			};

			await worker.synthesize(
				text,
				{
					speed: this.settings.speed,
					variation: this.settings.variation,
					seed: this.settings.seed,
					markdownNormalization: this.settings.markdownNormalization,
					markdownRules: this.settings.markdownRules,
				},
				(chunk) => {
					if (abort.signal.aborted) return;
					const durationSeconds = chunk.waveform.length / 24000;
					if (!this.player.isPlaying && pendingChunks.length === 0 && durationSeconds < 1.0) {
						pendingChunks.push(chunk);
						return;
					}
					while (pendingChunks.length > 0) {
						const buffered = pendingChunks.shift();
						if (buffered) enqueueChunk(buffered);
					}
					enqueueChunk(chunk);
				},
				abort.signal,
			);

			if (!abort.signal.aborted) {
				while (pendingChunks.length > 0) {
					const buffered = pendingChunks.shift();
					if (buffered) enqueueChunk(buffered);
				}
			}
		} catch (error) {
			if (!abort.signal.aborted) {
				console.error("Local Voiceover synthesis failed", error);
				const message = error instanceof Error ? error.message : "Unknown synthesis error.";
				new Notice(`Local Voiceover: ${message}`);
			}
		} finally {
			if (this.abortController === abort) this.abortController = null;
			this.syncPlaybackState();
		}
	}

	private getWorker(): Promise<SpeechWorkerClient> {
		if (this.worker) return Promise.resolve(this.worker);
		if (this.loading) return this.loading;
		new Notice("Preparing local voice model…");
		const pluginDirectory = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		const cache = new ModelCache(this.app.vault.adapter, pluginDirectory);
		this.loading = Promise.all([
			cache.loadModel("duration.onnx", () => undefined),
			cache.loadModel("decode.onnx", () => undefined),
			cache.loadRuntime("ort-wasm-simd-threaded.jsep.mjs", () => undefined),
			cache.loadRuntime("ort-wasm-simd-threaded.jsep.wasm", () => undefined),
		]).then(async ([core, decoder]) => {
			const worker = new SpeechWorkerClient(workerSource);
			await worker.initialize(
				{ "duration.onnx": core, "decode.onnx": decoder },
				{
					mjs: cache.resourcePath("ort-wasm-simd-threaded.jsep.mjs"),
					wasm: cache.resourcePath("ort-wasm-simd-threaded.jsep.wasm"),
				},
			);
			this.worker = worker;
			new Notice("Local voice model is ready.");
			window.dispatchEvent(new Event("local-voiceover-state"));
			return worker;
		}).finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	private isBusy(): boolean {
		return this.abortController !== null || this.player.isPlaying || this.webPlayer.isPlaying;
	}

	private stop(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.player.stop();
		this.webPlayer.stop();
		this.clearHighlight();
		this.unlockPlaybackRange();
		this.setState("idle");
		new Notice("Speech stopped.");
	}

	private syncPlaybackState(): void {
		if (!this.abortController && !this.player.isPlaying && !this.webPlayer.isPlaying) {
			this.clearHighlight();
			this.unlockPlaybackRange();
			this.setState("idle");
		}
	}

	private setState(state: VoiceoverState): void {
		if (this.state === state) return;
		this.state = state;
		window.dispatchEvent(new Event("local-voiceover-state"));
	}

	private disposeRuntime(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.player.stop();
		this.webPlayer.stop();
		this.clearHighlight();
		this.unlockPlaybackRange();
		this.worker?.dispose();
		this.worker = null;
	}
}
