import { type App, type Plugin, PluginSettingTab, Setting, ToggleComponent } from "obsidian";
import { normalizeSpeechSettings, type LocalVoiceoverSettings, type TTSEngine } from "./settings";
import { WebSpeechPlayer, type VoiceInfo } from "./webSpeechPlayer";

type SettingsPlugin = {
	settings: LocalVoiceoverSettings;
	saveSettings(): Promise<void>;
	clearHighlight(): void;
};

function addInfo(setting: Setting, explanation: string): void {
	const button = setting.nameEl.createEl("button", {
		cls: "local-voiceover-setting-info",
		attr: { type: "button", "aria-label": explanation },
	});
	button.setText("I");
}

function addSection(container: HTMLElement, label: string): void {
	container.createDiv({ cls: "local-voiceover-settings-section", text: label });
}

function createMarkdownRules(container: HTMLElement, voiceover: SettingsPlugin): HTMLElement {
	const table = container.createDiv({ cls: "local-voiceover-markdown-rules" });
	const header = table.createDiv({ cls: "local-voiceover-markdown-rule local-voiceover-markdown-rule-header" });
	header.createSpan({ text: "Markdown syntax" });
	header.createSpan({ text: "Spoken as" });
	header.createSpan({ text: "Apply" });
	const rules: [keyof LocalVoiceoverSettings["markdownRules"], string, string][] = [
		["headings", "# Introduction", "Introduction"],
		["emphasis", "**Play** / *Play*", "Play"],
		["links", "[Obsidian](url)", "Obsidian"],
		["listsAndQuotes", "- Item / > Quote", "Item / Quote"],
		["code", "`code` / ``` block", "code / block content"],
		["strikethroughAndRules", "~~Removed~~ / ---", "Removed / omitted"],
	];
	for (const [key, syntax, spoken] of rules) {
		const row = table.createDiv({ cls: "local-voiceover-markdown-rule" });
		row.createEl("code", { text: syntax });
		row.createSpan({ cls: "local-voiceover-markdown-spoken", text: spoken });
		new ToggleComponent(row).setValue(voiceover.settings.markdownRules[key]).onChange(async (value) => {
			voiceover.settings.markdownRules[key] = value;
			await voiceover.saveSettings();
		});
	}
	return table;
}

export class LocalVoiceoverSettingTab extends PluginSettingTab {
	private readonly voiceover: SettingsPlugin;
	private cachedVoices: VoiceInfo[] = [];

	constructor(app: App, plugin: Plugin) {
		super(app, plugin);
		this.voiceover = plugin as unknown as SettingsPlugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const hasWebSpeech = WebSpeechPlayer.isSupported();
		if (!hasWebSpeech && this.voiceover.settings.ttsEngine === "system") {
			this.voiceover.settings.ttsEngine = "inflect";
			void this.voiceover.saveSettings();
		}

		addSection(containerEl, "Engine");
		const engineSetting = new Setting(containerEl).setName("Voice engine");
		addInfo(engineSetting, "Choose between native operating system voices (zero download) or local ONNX synthesis.");

		const options: Record<string, string> = {};
		if (hasWebSpeech) {
			options.system = "System (Native OS Voices)";
		} else {
			options.system = "System (Unavailable on mobile WebView)";
		}
		options.inflect = "Inflect Micro v2 (Local ONNX)";

		engineSetting.addDropdown((dropdown) => dropdown
			.addOptions(options)
			.setValue(this.voiceover.settings.ttsEngine)
			.onChange(async (value) => {
				if (!hasWebSpeech && value === "system") {
					this.voiceover.settings.ttsEngine = "inflect";
				} else {
					this.voiceover.settings.ttsEngine = value as TTSEngine;
				}
				await this.voiceover.saveSettings();
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				this.display();
			}));

		if (!hasWebSpeech) {
			const noticeEl = containerEl.createDiv({ cls: "local-voiceover-settings-notice" });
			noticeEl.setText("Notice: Web speech API is not supported by Android webview. Automatically using inflect micro v2 on this device.");
		}

		addSection(containerEl, "Voice");

		if (this.voiceover.settings.ttsEngine === "system") {
			const voiceSetting = new Setting(containerEl).setName("System voice");
			addInfo(voiceSetting, "Choose from the voices installed on your operating system or Android device.");

			const populateVoices = (voices: VoiceInfo[]) => {
				voiceSetting.controlEl.empty();
				voiceSetting.addDropdown((dropdown) => {
					const options: Record<string, string> = {};
					if (voices.length === 0) {
						options[""] = "Default System Voice";
					} else {
						for (const voice of voices) {
							options[voice.voiceURI] = `${voice.name} (${voice.lang})`;
						}
					}
					dropdown.addOptions(options);
					const currentURI = this.voiceover.settings.systemVoiceURI;
					const isValid = voices.some((v) => v.voiceURI === currentURI);
					const valueToSet = isValid ? currentURI : (voices[0]?.voiceURI ?? "");
					dropdown.setValue(valueToSet).onChange(async (selected) => {
						this.voiceover.settings.systemVoiceURI = selected;
						await this.voiceover.saveSettings();
					});
				});
			};

			if (this.cachedVoices.length > 0) {
				populateVoices(this.cachedVoices);
			} else {
				voiceSetting.addDropdown((dropdown) => {
					dropdown.addOption("", "Loading system voices…").setDisabled(true);
				});
				void WebSpeechPlayer.getAvailableVoices()
					.then((voices) => {
						this.cachedVoices = voices;
						populateVoices(voices);
					})
					.catch((err: unknown) => {
						console.error("Failed to get system voices", err);
					});
			}

			const pitch = new Setting(containerEl).setName("Pitch");
			addInfo(pitch, "Voice pitch. Choose a value from 0.5 to 1.5 (default: 1.0).");
			pitch.addSlider((slider) => {
				const input = (slider.sliderEl.parentElement as HTMLElement).createEl("input", {
					cls: "local-voiceover-slider-value",
					type: "number",
					value: this.voiceover.settings.systemPitch.toFixed(2),
				});
				input.min = "0.5";
				input.max = "1.5";
				input.step = "0.05";
				input.addEventListener("change", () => void (async () => {
					const value = Number(input.value);
					if (!Number.isFinite(value)) return;
					this.voiceover.settings.systemPitch = value;
					normalizeSpeechSettings(this.voiceover.settings);
					input.value = this.voiceover.settings.systemPitch.toFixed(2);
					slider.setValue(this.voiceover.settings.systemPitch);
					await this.voiceover.saveSettings();
				})());
				return slider.setLimits(0.5, 1.5, 0.05).setValue(this.voiceover.settings.systemPitch).onChange(async (value) => {
					input.value = value.toFixed(2);
					this.voiceover.settings.systemPitch = value;
					await this.voiceover.saveSettings();
				});
			});
		}

		const speed = new Setting(containerEl).setName("Speed");
		addInfo(speed, "Speech speed. Lower is slower. Choose a value from 0.5 to 2.0.");
		speed.addSlider((slider) => {
			const input = (slider.sliderEl.parentElement as HTMLElement).createEl("input", {
				cls: "local-voiceover-slider-value",
				type: "number",
				value: this.voiceover.settings.speed.toFixed(2),
			});
			input.min = "0.5";
			input.max = "2";
			input.step = "0.05";
			input.addEventListener("change", () => void (async () => {
				const value = Number(input.value);
				if (!Number.isFinite(value)) return;
				this.voiceover.settings.speed = value;
				normalizeSpeechSettings(this.voiceover.settings);
				input.value = this.voiceover.settings.speed.toFixed(2);
				slider.setValue(this.voiceover.settings.speed);
				await this.voiceover.saveSettings();
			})());
			return slider.setLimits(0.5, 2, 0.05).setValue(this.voiceover.settings.speed).onChange(async (value) => {
				input.value = value.toFixed(2);
				this.voiceover.settings.speed = value;
				await this.voiceover.saveSettings();
			});
		});

		if (this.voiceover.settings.ttsEngine === "inflect") {
			const variation = new Setting(containerEl).setName("Variation");
			addInfo(variation, "Voice variation. Lower is steadier. Choose a value from 0 to 1.");
			variation.addSlider((slider) => {
				const input = (slider.sliderEl.parentElement as HTMLElement).createEl("input", {
					cls: "local-voiceover-slider-value",
					type: "number",
					value: this.voiceover.settings.variation.toFixed(2),
				});
				input.min = "0";
				input.max = "1";
				input.step = "0.01";
				input.addEventListener("change", () => void (async () => {
					const value = Number(input.value);
					if (!Number.isFinite(value)) return;
					this.voiceover.settings.variation = value;
					normalizeSpeechSettings(this.voiceover.settings);
					input.value = this.voiceover.settings.variation.toFixed(2);
					slider.setValue(this.voiceover.settings.variation);
					await this.voiceover.saveSettings();
				})());
				return slider.setLimits(0, 1, 0.01).setValue(this.voiceover.settings.variation).onChange(async (value) => {
					input.value = value.toFixed(2);
					this.voiceover.settings.variation = value;
					await this.voiceover.saveSettings();
				});
			});

			const seed = new Setting(containerEl).setName("Seed");
			addInfo(seed, "A safe integer. The same seed repeats the same sample on this runtime.");
			seed.addText((text) => text.setValue(String(this.voiceover.settings.seed)).onChange(async (value) => {
				const parsed = Number(value);
				if (!Number.isSafeInteger(parsed)) return;
				this.voiceover.settings.seed = parsed;
				normalizeSpeechSettings(this.voiceover.settings);
				await this.voiceover.saveSettings();
			}));
		}

		addSection(containerEl, "Markdown");
		const markdown = new Setting(containerEl).setName("Markdown normalization");
		addInfo(markdown, "Choose how selected Markdown is prepared before speech.");
		const markdownRules = createMarkdownRules(containerEl, this.voiceover);
		const updateMarkdownRules = () => markdownRules.toggle(this.voiceover.settings.markdownNormalization === "custom");
		markdown.addDropdown((dropdown) => dropdown
			.addOptions({ default: "Default", none: "None", custom: "Custom" })
			.setValue(this.voiceover.settings.markdownNormalization)
			.onChange(async (value) => {
				this.voiceover.settings.markdownNormalization = value as LocalVoiceoverSettings["markdownNormalization"];
				updateMarkdownRules();
				await this.voiceover.saveSettings();
			}));
		updateMarkdownRules();

		addSection(containerEl, "Playback");
		const highlight = new Setting(containerEl).setName("Highlight spoken text");
		addInfo(highlight, "Highlight the currently playing text chunk in the editor.");
		highlight.addToggle((toggle) => toggle.setValue(this.voiceover.settings.highlightSpokenText).onChange(async (value) => {
			this.voiceover.settings.highlightSpokenText = value;
			this.voiceover.clearHighlight();
			await this.voiceover.saveSettings();
		}));

		const autoScroll = new Setting(containerEl).setName("Auto-scroll to spoken sentence");
		addInfo(autoScroll, "Automatically keep the editor scrolled to the currently spoken sentence.");
		autoScroll.addToggle((toggle) => toggle.setValue(this.voiceover.settings.autoScrollToSpokenText).onChange(async (value) => {
			this.voiceover.settings.autoScrollToSpokenText = value;
			await this.voiceover.saveSettings();
		}));
	}
}
