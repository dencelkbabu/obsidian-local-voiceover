import { Editor, MarkdownView, Notice, Plugin, normalizePath, setIcon } from "obsidian";
import { ModelCache } from "./src/modelCache";
import { StreamPlayer } from "./src/player";
import { WebSpeechPlayer } from "./src/webSpeechPlayer";
import { boundaryPauseSeconds, edgeFade } from "./src/port/runtime.mjs";
import { createSelectionToolbarExtension, playbackHighlightExtension, type VoiceoverState } from "./src/selectionToolbar";
import { DEFAULT_SETTINGS, DEFAULT_MARKDOWN_RULES, normalizeSpeechSettings, type LocalVoiceoverSettings, type TTSEngine } from "./src/settings";
import { LocalVoiceoverSettingTab } from "./src/settingsTab";
import workerSource from "./src/generatedWorker";
import kokoroWorkerSource from "./src/generatedKokoroWorker";
import { SpeechWorkerClient } from "./src/workerClient";
import { KokoroWorkerClient } from "./src/kokoroWorkerClient";
import { stripMarkdown } from "./src/port/frontend.mjs";

export default class LocalVoiceoverPlugin extends Plugin {
	settings: LocalVoiceoverSettings = DEFAULT_SETTINGS;
	private readonly player = new StreamPlayer();
	private readonly webPlayer = new WebSpeechPlayer();
	private abortController: AbortController | null = null;
	private worker: SpeechWorkerClient | null = null;
	private loading: Promise<SpeechWorkerClient> | null = null;
	private kokoroWorker: KokoroWorkerClient | null = null;
	private kokoroLoading: Promise<KokoroWorkerClient> | null = null;
	private state: VoiceoverState = "idle";
	private ribbonIconEl: HTMLElement | null = null;
	private viewActionEls = new Set<HTMLElement>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.player.setOnStateChange(() => this.syncPlaybackState());
		this.webPlayer.setOnStateChange(() => this.syncPlaybackState());
		this.webPlayer.setOnChunkStart((source) => {
			if (this.settings.highlightSpokenText || this.settings.autoScrollToSpokenText) {
				window.dispatchEvent(new CustomEvent("local-voiceover-highlight", { detail: { source } }));
			}
		});

		this.addSettingTab(new LocalVoiceoverSettingTab(this.app, this));
		this.registerEditorExtension([
			playbackHighlightExtension,
			createSelectionToolbarExtension({
				getState: () => this.state,
				isHighlightEnabled: () => this.settings.highlightSpokenText,
				isAutoScrollEnabled: () => this.settings.autoScrollToSpokenText,
				speak: (text, from) => void this.speak(text, from),
				pause: () => void this.pause(),
				resume: () => void this.resume(),
				stop: () => this.stop(),
			}),
		]);

		this.registerViewActions();

		this.ribbonIconEl = this.addRibbonIcon("volume-2", "Local voiceover: Speak note or selection", () => {
			void this.togglePlayback();
		});

		this.addCommand({
			id: "speak-note-or-selection",
			name: "Speak note or selection",
			checkCallback: (checking) => {
				const context = this.getActiveNoteContext();
				if (!context && !this.isBusy()) return false;
				if (!checking) {
					void this.togglePlayback();
				}
				return true;
			},
		});

		this.addCommand({
			id: "toggle-play-pause",
			name: "Toggle play / pause speech",
			checkCallback: (checking) => {
				if (!this.isBusy() && !this.getActiveNoteContext()) return false;
				if (!checking) {
					void this.togglePlayback();
				}
				return true;
			},
		});

		this.addCommand({
			id: "pause-speaking",
			name: "Pause speaking",
			checkCallback: (checking) => {
				if (this.state !== "speaking") return false;
				if (!checking) void this.pause();
				return true;
			},
		});

		this.addCommand({
			id: "resume-speaking",
			name: "Resume speaking",
			checkCallback: (checking) => {
				if (this.state !== "paused") return false;
				if (!checking) void this.resume();
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
				if (!this.isBusy() && this.state === "idle") return false;
				if (!checking) this.stop();
				return true;
			},
		});

		const onHighlight = (event: Event) => {
			if (!this.settings.autoScrollToSpokenText) return;
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView || activeView.getMode() !== "preview") return;

			const source = (event as CustomEvent<{ source?: string }>).detail?.source;
			if (!source) return;

			const previewEl = activeView.previewMode?.containerEl;
			if (!previewEl) return;

			const words = source.match(/[\p{L}\p{N}]+/gu);
			if (!words || words.length === 0) return;
			const search = words.slice(0, 4).join(" ").toLowerCase();

			const walker = activeDocument.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node) {
				if (node.textContent && node.textContent.toLowerCase().includes(search)) {
					const parentEl = node.parentElement;
					if (parentEl) {
						parentEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
						break;
					}
				}
				node = walker.nextNode();
			}
		};

		window.addEventListener("local-voiceover-highlight", onHighlight);
		this.register(() => window.removeEventListener("local-voiceover-highlight", onHighlight));

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

	getActiveEngine(): TTSEngine {
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

	private async togglePlayback(): Promise<void> {
		if (this.state === "speaking") {
			await this.pause();
		} else if (this.state === "paused") {
			await this.resume();
		} else if (this.state === "loading" || this.state === "generating") {
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
	}

	async pause(): Promise<void> {
		if (this.state !== "speaking") return;
		if (this.getActiveEngine() === "system") {
			this.webPlayer.pause();
		} else {
			await this.player.pause();
		}
		this.setState("paused");
		new Notice("Speech paused.");
	}

	async resume(): Promise<void> {
		if (this.state !== "paused") return;
		if (this.getActiveEngine() === "system") {
			this.webPlayer.resume();
		} else {
			await this.player.resume();
		}
		this.setState("speaking");
		new Notice("Speech resumed.");
	}

	private registerViewActions(): void {
		const addActionToView = (view: MarkdownView) => {
			if (view.containerEl.querySelector(".local-voiceover-view-action")) return;
			const actionEl = view.addAction("volume-2", "Local voiceover: Speak note or selection", () => {
				void this.togglePlayback();
			});
			actionEl.addClass("local-voiceover-view-action");
			this.viewActionEls.add(actionEl);
			this.updateActionIcons();
		};

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					addActionToView(leaf.view);
				}
			})
		);

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				addActionToView(leaf.view);
			}
		});
	}

	private updateActionIcons(): void {
		const getIconAndTitle = (state: VoiceoverState): { icon: string; title: string } => {
			switch (state) {
				case "speaking":
					return { icon: "pause", title: "Local voiceover: Pause speaking" };
				case "paused":
					return { icon: "play", title: "Local voiceover: Resume speaking" };
				case "loading":
				case "generating":
					return { icon: "loader", title: "Local voiceover: Stop speaking" };
				case "idle":
				default:
					return { icon: "volume-2", title: "Local voiceover: Speak note or selection" };
			}
		};

		const { icon, title } = getIconAndTitle(this.state);

		if (this.ribbonIconEl) {
			setIcon(this.ribbonIconEl, icon);
			this.ribbonIconEl.setAttribute("aria-label", title);
		}

		for (const el of Array.from(this.viewActionEls)) {
			if (!el.isConnected) {
				this.viewActionEls.delete(el);
			} else {
				setIcon(el, icon);
				el.setAttribute("aria-label", title);
			}
		}
	}

	private activeSpeakPromise: Promise<void> | null = null;

	private async speak(text: string, from = 0): Promise<void> {
		if (!text) return;
		if (this.isBusy()) {
			this.stop();
			if (this.activeSpeakPromise) {
				try {
					await this.activeSpeakPromise;
				} catch {
					// ignore previous abort
				}
			}
		}

		const promise = this.doSpeak(text, from);
		this.activeSpeakPromise = promise;
		try {
			await promise;
		} finally {
			if (this.activeSpeakPromise === promise) {
				this.activeSpeakPromise = null;
			}
		}
	}

	private async doSpeak(text: string, from = 0): Promise<void> {
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

		if (this.getActiveEngine() === "kokoro") {
			this.setState("loading");
			try {
				await this.player.start();
				const worker = await this.getKokoroWorker();
				if (abort.signal.aborted) return;
				this.setState("generating");
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				new Notice("Generating Kokoro speech…");

				const rules =
					this.settings.markdownNormalization === "custom"
						? { ...DEFAULT_MARKDOWN_RULES, ...this.settings.markdownRules }
						: DEFAULT_MARKDOWN_RULES;
				const stripMarkdownFn = stripMarkdown as (input: string, rules: Record<string, boolean>) => string;
				const normalizedText: string =
					this.settings.markdownNormalization === "none"
						? text
						: stripMarkdownFn(text, rules as unknown as Record<string, boolean>);

				const pendingChunks: Array<{ waveform: Float32Array; source: string }> = [];
				let totalBufferedDuration = 0;
				const enqueueChunk = (chunk: { waveform: Float32Array; source: string }) => {
					if (this.state !== "paused") {
						this.setState("speaking");
					}
					this.player.queue(
						edgeFade(chunk.waveform) as Float32Array,
						Number(boundaryPauseSeconds(chunk.source)),
						() => {
							if (this.settings.highlightSpokenText || this.settings.autoScrollToSpokenText)
								window.dispatchEvent(new CustomEvent("local-voiceover-highlight", { detail: { source: chunk.source } }));
						},
					);
				};

				await worker.synthesize(
					normalizedText,
					{
						voice: this.settings.kokoroVoice,
						speed: this.settings.speed,
						dtype: this.settings.kokoroDtype,
					},
					(chunk) => {
						if (abort.signal.aborted) return;
						const durationSeconds = chunk.waveform.length / 24000;
						if (!this.player.isPlaying && totalBufferedDuration < 2.5 && pendingChunks.length < 2) {
							pendingChunks.push(chunk);
							totalBufferedDuration += durationSeconds;
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
					console.error("Local Voiceover Kokoro synthesis failed", error);
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
				if (this.state !== "paused") {
					this.setState("speaking");
				}
				this.player.queue(
					edgeFade(chunk.waveform) as Float32Array,
					Number(boundaryPauseSeconds(chunk.source)),
					() => {
						if (this.settings.highlightSpokenText || this.settings.autoScrollToSpokenText)
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

	private getKokoroWorker(): Promise<KokoroWorkerClient> {
		if (this.kokoroWorker) return Promise.resolve(this.kokoroWorker);
		if (this.kokoroLoading) return this.kokoroLoading;

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("Preparing Kokoro-82M neural voice model…");
		const client = new KokoroWorkerClient(kokoroWorkerSource);
		let lastNoticeTime = 0;
		client.onProgress = (data: unknown) => {
			const info = data as { status?: string; file?: string; progress?: number };
			if (info && info.status === "progress" && typeof info.progress === "number") {
				const now = Date.now();
				if (now - lastNoticeTime > 2000) {
					lastNoticeTime = now;
					const pct = Math.round(info.progress);
					new Notice(`Kokoro-82M downloading (${info.file ?? "model"}): ${pct}%`);
				}
			}
		};

		this.kokoroLoading = client
			.initialize(this.settings.kokoroDtype)
			.then(() => {
				this.kokoroWorker = client;
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				new Notice("Kokoro-82M neural model is ready.");
				window.dispatchEvent(new Event("local-voiceover-state"));
				return client;
			})
			.finally(() => {
				this.kokoroLoading = null;
			});

		return this.kokoroLoading;
	}

	private isBusy(): boolean {
		return this.abortController !== null || this.player.isPlaying || this.webPlayer.isPlaying || this.state === "paused";
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
		if (this.state === "paused") {
			if (!this.player.isPlaying && !this.webPlayer.isPlaying) {
				this.clearHighlight();
				this.unlockPlaybackRange();
				this.setState("idle");
			}
			return;
		}
		if (!this.abortController && !this.player.isPlaying && !this.webPlayer.isPlaying) {
			this.clearHighlight();
			this.unlockPlaybackRange();
			this.setState("idle");
		}
	}

	private setState(state: VoiceoverState): void {
		if (this.state === state) return;
		this.state = state;
		this.updateActionIcons();
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
		this.kokoroWorker?.dispose();
		this.kokoroWorker = null;
	}
}
