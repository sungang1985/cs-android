/** Minimal recording fake of the WebAudio API (Node): enough for SoundBank and AudioEngine routing tests. */
export class FakeParam {
  value: number;
  readonly events: [string, number, number][] = [];
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v: number, t: number) { this.value = v; this.events.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['exp', v, t]); return this; }
  setTargetAtTime(v: number, t: number) { this.value = v; this.events.push(['target', v, t]); return this; }
  cancelScheduledValues(t: number) { this.events.push(['cancel', 0, t]); return this; }
}

export class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = false;
  constructor(readonly kind: string) {}
  connect(n: FakeNode) { this.outputs.push(n); return n; }
  disconnect() { this.disconnected = true; }
  /** Every node reachable downstream (to check what a voice is routed through). */
  chain(): FakeNode[] { const out: FakeNode[] = []; const walk = (n: FakeNode) => { for (const o of n.outputs) { out.push(o); walk(o); } }; walk(this); return out; }
}
export class FakeGain extends FakeNode { gain = new FakeParam(1); constructor() { super('gain'); } }
export class FakeBiquad extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1); constructor() { super('biquad'); } }
export class FakePanner extends FakeNode {
  panningModel = 'HRTF'; distanceModel = 'inverse'; refDistance = 1; maxDistance = 10000; rolloffFactor = 1;
  positionX = new FakeParam(); positionY = new FakeParam(); positionZ = new FakeParam();
  constructor() { super('panner'); }
}
export class FakeBuffer {
  readonly data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  get duration() { return this.length / this.sampleRate; }
  copyToChannel(src: Float32Array) { this.data.set(src); }
  getChannelData() { return this.data; }
}
export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null; loop = false; playbackRate = new FakeParam(1);
  started = false; stoppedAt: number | null = null; onended: (() => void) | null = null;
  constructor(private readonly ctx: FakeAudioContext) { super('source'); }
  start() { this.started = true; this.ctx.started.push(this); }
  stop(t?: number) { this.stoppedAt = t ?? this.ctx.currentTime; }
  end() { this.onended?.(); }
}

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly destination = new FakeNode('destination');
  readonly listener = { positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam(), forwardX: new FakeParam(), forwardY: new FakeParam(), forwardZ: new FakeParam(-1), upX: new FakeParam(), upY: new FakeParam(1), upZ: new FakeParam() };
  readonly started: FakeSource[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly opts: unknown;
  constructor(opts?: unknown) { this.opts = opts; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  createGain() { return new FakeGain(); }
  createBiquadFilter() { return new FakeBiquad(); }
  createPanner() { return new FakePanner(); }
  createDynamicsCompressor() { return Object.assign(new FakeNode('compressor'), { threshold: new FakeParam(-24), ratio: new FakeParam(12) }); }
  createBufferSource() { return new FakeSource(this); }
  createBuffer(ch: number, len: number, sr: number) { const b = new FakeBuffer(ch, len, sr); this.buffers.push(b); return b; }
}
