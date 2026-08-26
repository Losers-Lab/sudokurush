/**
 * Tiny WebAudio cue set — no assets, just oscillator blips. The context is
 * created lazily on first user gesture (autoplay policies) and every call
 * is failure-silent: sound must never break gameplay.
 */
class Sfx {
  private ctx: AudioContext | null = null;

  private tone(freq: number, durationMs: number, type: OscillatorType, gain = 0.04): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      const osc = this.ctx.createOscillator();
      const amp = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(gain, this.ctx.currentTime);
      amp.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + durationMs / 1000);
      osc.connect(amp).connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + durationMs / 1000);
    } catch {
      // No audio available; the game plays on silently.
    }
  }

  place(): void {
    this.tone(660, 90, "triangle");
  }

  note(): void {
    this.tone(440, 70, "sine", 0.03);
  }

  wrong(): void {
    this.tone(180, 160, "square", 0.05);
  }

  joined(): void {
    this.tone(520, 80, "triangle");
    setTimeout(() => this.tone(780, 100, "triangle"), 90);
  }

  completed(): void {
    [523, 659, 784, 1047].forEach((freq, index) => {
      setTimeout(() => this.tone(freq, 180, "triangle", 0.05), index * 130);
    });
  }
}

export const sfx = new Sfx();
