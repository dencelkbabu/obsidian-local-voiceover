interface ScheduledStart {
	startAt: number;
	callback: () => void;
	timer: number | null;
}

export class StreamPlayer {
	private context: AudioContext | null = null;
	private readonly sources = new Set<AudioBufferSourceNode>();
	private nextStart = 0;
	private readonly scheduledStarts = new Set<ScheduledStart>();
	private onStateChange: () => void = () => undefined;

	setOnStateChange(onStateChange: () => void): void {
		this.onStateChange = onStateChange;
	}

	get isPlaying(): boolean {
		return this.sources.size > 0;
	}

	get isPaused(): boolean {
		return this.context?.state === "suspended";
	}

	async start(): Promise<void> {
		this.stop();
		this.context = new AudioContext({ sampleRate: 24000 });
		await this.context.resume();
		this.nextStart = this.context.currentTime + 0.05;
	}

	queue(samples: Float32Array, pauseSeconds: number, onStart?: () => void): void {
		if (!this.context) throw new Error("Audio playback has not started.");
		const buffer = this.context.createBuffer(1, samples.length, 24000);
		buffer.copyToChannel(new Float32Array(samples), 0);
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.context.destination);
		source.addEventListener("ended", () => {
			this.sources.delete(source);
			this.onStateChange();
		});
		const startAt = Math.max(this.nextStart, this.context.currentTime + 0.05);
		source.start(startAt);
		if (onStart) {
			const item: ScheduledStart = {
				startAt,
				callback: onStart,
				timer: null,
			};
			if (this.context.state === "running") {
				const delay = Math.max(0, (startAt - this.context.currentTime) * 1000);
				item.timer = window.setTimeout(() => {
					this.scheduledStarts.delete(item);
					item.callback();
				}, delay);
			}
			this.scheduledStarts.add(item);
		}
		this.nextStart = startAt + buffer.duration + pauseSeconds;
		this.sources.add(source);
		this.onStateChange();
	}

	async pause(): Promise<void> {
		if (this.context && this.context.state === "running") {
			for (const item of this.scheduledStarts) {
				if (item.timer !== null) {
					window.clearTimeout(item.timer);
					item.timer = null;
				}
			}
			await this.context.suspend();
			this.onStateChange();
		}
	}

	async resume(): Promise<void> {
		if (this.context && this.context.state === "suspended") {
			await this.context.resume();
			for (const item of this.scheduledStarts) {
				const delay = Math.max(0, (item.startAt - (this.context?.currentTime ?? 0)) * 1000);
				item.timer = window.setTimeout(() => {
					this.scheduledStarts.delete(item);
					item.callback();
				}, delay);
			}
			this.onStateChange();
		}
	}

	stop(): void {
		for (const source of this.sources) source.stop();
		this.sources.clear();
		for (const item of this.scheduledStarts) {
			if (item.timer !== null) window.clearTimeout(item.timer);
		}
		this.scheduledStarts.clear();
		void this.context?.close();
		this.context = null;
		this.onStateChange();
	}
}
