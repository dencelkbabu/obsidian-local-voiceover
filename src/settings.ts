export type MarkdownNormalizationMode = "default" | "none" | "custom";

export interface MarkdownNormalizationRules {
	headings: boolean;
	emphasis: boolean;
	links: boolean;
	listsAndQuotes: boolean;
	code: boolean;
	strikethroughAndRules: boolean;
}

export type TTSEngine = "system" | "inflect" | "kokoro";

export interface LocalVoiceoverSettings {
	ttsEngine: TTSEngine;
	systemVoiceURI: string;
	systemPitch: number;
	kokoroVoice: string;
	kokoroDtype: "q8" | "fp32";
	highlightSpokenText: boolean;
	autoScrollToSpokenText: boolean;
	speed: number;
	variation: number;
	seed: number;
	markdownNormalization: MarkdownNormalizationMode;
	markdownRules: MarkdownNormalizationRules;
}

export const DEFAULT_MARKDOWN_RULES: MarkdownNormalizationRules = {
	headings: true,
	emphasis: true,
	links: true,
	listsAndQuotes: true,
	code: true,
	strikethroughAndRules: true,
};

export const DEFAULT_SETTINGS: LocalVoiceoverSettings = {
	ttsEngine: "system",
	systemVoiceURI: "",
	systemPitch: 1,
	kokoroVoice: "af_heart",
	kokoroDtype: "q8",
	highlightSpokenText: true,
	autoScrollToSpokenText: true,
	speed: 1,
	variation: 0.667,
	seed: 0,
	markdownNormalization: "default",
	markdownRules: { ...DEFAULT_MARKDOWN_RULES },
};

export function normalizeSpeechSettings(settings: LocalVoiceoverSettings): void {
	if (!(["system", "inflect", "kokoro"] as const).includes(settings.ttsEngine))
		settings.ttsEngine = DEFAULT_SETTINGS.ttsEngine;
	if (typeof settings.systemVoiceURI !== "string")
		settings.systemVoiceURI = DEFAULT_SETTINGS.systemVoiceURI;
	if (typeof settings.systemPitch !== "number" || Number.isNaN(settings.systemPitch))
		settings.systemPitch = DEFAULT_SETTINGS.systemPitch;
	else
		settings.systemPitch = Math.min(1.5, Math.max(0.5, settings.systemPitch));
	if (typeof settings.kokoroVoice !== "string")
		settings.kokoroVoice = DEFAULT_SETTINGS.kokoroVoice;
	if (!(["q8", "fp32"] as const).includes(settings.kokoroDtype))
		settings.kokoroDtype = DEFAULT_SETTINGS.kokoroDtype;
	if (typeof settings.highlightSpokenText !== "boolean")
		settings.highlightSpokenText = DEFAULT_SETTINGS.highlightSpokenText;
	if (typeof settings.autoScrollToSpokenText !== "boolean")
		settings.autoScrollToSpokenText = DEFAULT_SETTINGS.autoScrollToSpokenText;
	settings.speed = Math.min(2, Math.max(0.5, settings.speed));
	settings.variation = Math.min(1, Math.max(0, settings.variation));
	settings.seed = Number.isSafeInteger(settings.seed) ? settings.seed : DEFAULT_SETTINGS.seed;
	if (!(["default", "none", "custom"] as const).includes(settings.markdownNormalization))
		settings.markdownNormalization = DEFAULT_SETTINGS.markdownNormalization;
	settings.markdownRules = { ...DEFAULT_MARKDOWN_RULES, ...settings.markdownRules };
}
