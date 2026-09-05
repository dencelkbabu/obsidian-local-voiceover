import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { setIcon } from "obsidian";

export type VoiceoverState = "idle" | "loading" | "generating" | "speaking" | "paused";

export interface SelectionToolbarActions {
	getState(): VoiceoverState;
	isHighlightEnabled(): boolean;
	speak(text: string, from?: number): void;
	pause?(): void;
	resume?(): void;
	stop(): void;
}

const setPlaybackHighlight = StateEffect.define<{ from: number; to: number } | null>();
const spokenRangeLock = StateEffect.define<{ from: number; to: number } | null>();
const spokenRangeLockField = StateField.define<{ from: number; to: number } | null>({
	create: () => null,
	update(value, transaction) {
		// Insertions at the end belong after the protected source range, not inside it.
		let next = value ? { from: transaction.changes.mapPos(value.from, 1), to: transaction.changes.mapPos(value.to, -1) } : null;
		for (const effect of transaction.effects) if (effect.is(spokenRangeLock)) next = effect.value;
		return next;
	},
});
const spokenRangeLockFilter = EditorState.transactionFilter.of((transaction) => {
	const lock = transaction.startState.field(spokenRangeLockField);
	if (!lock || !transaction.docChanged) return transaction;
	let overlaps = false;
	transaction.changes.iterChanges((fromA, toA) => {
		if (fromA === toA ? fromA > lock.from && fromA < lock.to : fromA < lock.to && toA > lock.from)
			overlaps = true;
	});
	return overlaps ? [] : transaction;
});
const spokenRangeLockDecoration = EditorView.decorations.from(spokenRangeLockField, (lock) =>
	lock ? Decoration.set([Decoration.mark({ class: "local-voiceover-locked-text" }).range(lock.from, lock.to)]) : Decoration.none,
);

const playbackHighlightField = StateField.define({
	create: () => Decoration.none,
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setPlaybackHighlight)) {
				if (!effect.value) return Decoration.none;
				return Decoration.set([
					Decoration.mark({ class: "local-voiceover-playing-text" }).range(effect.value.from, effect.value.to),
				]);
			}
		}
		return value.map(transaction.changes);
	},
});

export const playbackHighlightExtension: Extension = [
	spokenRangeLockField,
	spokenRangeLockFilter,
	spokenRangeLockDecoration,
	playbackHighlightField,
	EditorView.decorations.from(playbackHighlightField),
];

export function createSelectionToolbarExtension(actions: SelectionToolbarActions): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly toolbar: HTMLElement;
			private readonly playButton: HTMLButtonElement;
			private readonly stopButton: HTMLButtonElement;
			private readonly status: HTMLElement;
			private selectedText = "";
			private selectedFrom = 0;
			private playbackText = "";
			private playbackFrom = 0;
			private highlightOffset = 0;
			private destroyed = false;
			private clearPending = false;
			private unlockPending = false;
			private lockGeneration = 0;
			private readonly refresh = () => this.scheduleRender();
			private readonly highlightChunk = (event: Event) => this.applyChunkHighlight(event);
			private readonly startPlayback = (event?: Event) => {
				this.lockGeneration += 1;
				const detail = (event as CustomEvent<{ text?: string; from?: number }> | undefined)?.detail;
				if (detail?.text) {
					this.playbackText = detail.text;
					this.playbackFrom = detail.from ?? 0;
				} else {
					this.playbackText = this.selectedText;
					this.playbackFrom = this.selectedFrom;
				}
				this.highlightOffset = 0;
				if (this.playbackText && this.view.hasFocus) {
					this.view.dispatch({ effects: spokenRangeLock.of({ from: this.playbackFrom, to: this.playbackFrom + this.playbackText.length }) });
				}
			};
			private readonly clearLock = () => {
				if (this.unlockPending) return;
				this.unlockPending = true;
				const generation = this.lockGeneration;
				window.setTimeout(() => {
					this.unlockPending = false;
					if (!this.destroyed && generation === this.lockGeneration) this.view.dispatch({ effects: spokenRangeLock.of(null) });
				}, 0);
			};
			private readonly clearHighlight = () => {
				if (this.clearPending) return;
				this.clearPending = true;
				window.setTimeout(() => {
					this.clearPending = false;
					if (!this.destroyed) this.view.dispatch({ effects: setPlaybackHighlight.of(null) });
				}, 0);
			};

			constructor(private readonly view: EditorView) {
				this.toolbar = this.view.dom.ownerDocument.body.createDiv({ cls: "local-voiceover-selection-toolbar" });
				this.playButton = this.toolbar.createEl("button", {
					cls: "clickable-icon local-voiceover-selection-toolbar__button",
					attr: { "aria-label": "Speak selected text", "data-tooltip-position": "top" },
				});
				setIcon(this.playButton, "play");
				this.stopButton = this.toolbar.createEl("button", {
					cls: "clickable-icon local-voiceover-selection-toolbar__button",
					attr: { "aria-label": "Stop speaking", "data-tooltip-position": "top" },
				});
				setIcon(this.stopButton, "square");
				this.status = this.toolbar.createSpan({ cls: "local-voiceover-selection-toolbar__status" });
				for (const button of [this.playButton, this.stopButton]) button.addEventListener("mousedown", (event) => event.preventDefault());
				this.playButton.addEventListener("click", () => {
					const state = actions.getState();
					if (state === "speaking") {
						actions.pause?.();
					} else if (state === "paused") {
						actions.resume?.();
					} else if (state === "idle") {
						actions.speak(this.selectedText, this.selectedFrom);
					}
				});
				this.stopButton.addEventListener("click", () => actions.stop());
				window.addEventListener("local-voiceover-state", this.refresh);
				window.addEventListener("local-voiceover-highlight", this.highlightChunk);
				window.addEventListener("local-voiceover-playback-start", this.startPlayback);
				window.addEventListener("local-voiceover-range-unlock", this.clearLock);
				window.addEventListener("local-voiceover-highlight-clear", this.clearHighlight);
				this.scheduleRender();
			}

			update(update: ViewUpdate): void {
				if (update.docChanged && this.playbackText) {
					// The transaction filter permits only changes outside the locked range.
					// Mapping keeps future chunk highlights attached to the same source text.
					this.playbackFrom = update.changes.mapPos(this.playbackFrom);
				}
				if (update.selectionSet || update.geometryChanged || update.viewportChanged || update.focusChanged) this.scheduleRender();
			}

			destroy(): void {
				this.destroyed = true;
				window.removeEventListener("local-voiceover-state", this.refresh);
				window.removeEventListener("local-voiceover-highlight", this.highlightChunk);
				window.removeEventListener("local-voiceover-playback-start", this.startPlayback);
				window.removeEventListener("local-voiceover-range-unlock", this.clearLock);
				window.removeEventListener("local-voiceover-highlight-clear", this.clearHighlight);
				this.toolbar.remove();
			}

			private scheduleRender(): void {
				const state = actions.getState();
				const isBusy = state !== "idle";
				const selection = this.view.state.selection.main;
				this.selectedFrom = selection.from;
				this.selectedText = this.view.state.sliceDoc(selection.from, selection.to).trim();

				if (!isBusy && (!this.selectedText || !this.view.hasFocus)) {
					this.clearHighlight();
					this.applyPosition(null, state);
					return;
				}

				this.view.requestMeasure({
					read: () => {
						if (this.selectedText && this.view.hasFocus) {
							const coords = this.view.coordsAtPos(selection.from);
							if (coords) {
								return { left: coords.left, top: Math.max(8, coords.top - 8), isDocked: false };
							}
						}
						if (isBusy) {
							const rect = this.view.dom.getBoundingClientRect();
							if (rect.width === 0 || rect.height === 0) return null;
							const toolbarWidth = this.toolbar.offsetWidth || 155;
							const toolbarHeight = this.toolbar.offsetHeight || 34;
							const left = Math.max(rect.left + 16, rect.right - toolbarWidth - 24);
							const top = Math.max(toolbarHeight + 8, rect.top + toolbarHeight + 12);
							return { left, top, isDocked: true };
						}
						return null;
					},
					write: (pos) => this.applyPosition(pos, state),
				});
			}

			private applyChunkHighlight(event: Event): void {
				if (!actions.isHighlightEnabled() || !this.playbackText) return;
				const source = (event as CustomEvent<{ source?: string }>).detail?.source;
				if (!source) return;
				const range = this.findSourceRange(source);
				if (!range) return;
				this.highlightOffset = range.to;
				this.view.dispatch({
					effects: setPlaybackHighlight.of({ from: this.playbackFrom + range.from, to: this.playbackFrom + range.to }),
				});
			}

			private findSourceRange(source: string): { from: number; to: number } | null {
				const direct = this.playbackText.indexOf(source, this.highlightOffset);
				if (direct >= 0) return { from: direct, to: direct + source.length };
				const words = source.match(/[\p{L}\p{N}]+/gu);
				if (!words?.length) return null;
				const tokens = /[\p{L}\p{N}]+/gu;
				tokens.lastIndex = this.highlightOffset;
				let from = -1;
				let to = -1;
				for (const word of words) {
					let token = tokens.exec(this.playbackText);
					while (token && token[0].toLocaleLowerCase() !== word.toLocaleLowerCase())
						token = tokens.exec(this.playbackText);
					if (!token) return null;
					if (from < 0) from = token.index;
					to = token.index + token[0].length;
				}
				return { from, to };
			}

			private applyPosition(pos: { left: number; top: number; isDocked: boolean } | null, state: VoiceoverState): void {
				if (!pos) {
					this.toolbar.hide();
					return;
				}
				this.toolbar.toggleClass("local-voiceover-selection-toolbar--docked", pos.isDocked);
				this.playButton.disabled = state === "loading" || state === "generating";
				this.stopButton.disabled = state === "idle";
				if (state === "speaking") {
					setIcon(this.playButton, "pause");
					this.playButton.setAttribute("aria-label", "Pause speaking");
				} else if (state === "paused") {
					setIcon(this.playButton, "play");
					this.playButton.setAttribute("aria-label", "Resume speaking");
				} else {
					setIcon(this.playButton, "play");
					this.playButton.setAttribute("aria-label", "Speak selected text");
				}
				this.status.setText(
					({ idle: "Ready", loading: "Loading", generating: "Generating", speaking: "Speaking", paused: "Paused" })[
						state
					],
				);
				this.toolbar.style.left = `${pos.left}px`;
				this.toolbar.style.top = `${pos.top}px`;
				this.toolbar.show();
			}
		},
	);
}
