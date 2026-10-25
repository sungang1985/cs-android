/**
 * Sound bank (§9.1): renders every BankId into AudioBuffers once at startup (2 variants for shots, footsteps,
 * impacts and hits, 1 otherwise; ambient_hum at 22.05 kHz) ≈ 72 buffers. `build` yields to the event loop
 * between renders and reports progress for the loading screen. The buffer factory is the AudioContext (any
 * BaseAudioContext), or a fake in Node tests.
 */
import { BANK_IDS, RECIPE_SPEC, renderRecipe, type BankId } from './recipes';

/** The part of BaseAudioContext the bank needs. */
export interface BufferFactory { createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer }

export interface BankEntry { id: BankId; variant: number; sampleRate: number }

/** Every (id, variant) to render, in a stable order. */
export function bankPlan(): BankEntry[] {
  const out: BankEntry[] = [];
  for (const id of BANK_IDS) for (let v = 0; v < RECIPE_SPEC[id].variants; v++) out.push({ id, variant: v, sampleRate: RECIPE_SPEC[id].sampleRate });
  return out;
}

export class SoundBank {
  private readonly buffers = new Map<BankId, AudioBuffer[]>();
  /** Float32 bytes held by the bank. */
  totalBytes = 0;
  count = 0;

  private add(f: BufferFactory, e: BankEntry): void {
    const data = renderRecipe(e.id, e.variant);
    const buf = f.createBuffer(1, data.length, e.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    let list = this.buffers.get(e.id);
    if (!list) { list = []; this.buffers.set(e.id, list); }
    list[e.variant] = buf;
    this.totalBytes += data.length * 4; this.count++;
  }

  /** Renders everything synchronously (tests, workers). */
  static buildSync(f: BufferFactory, onProgress?: (done: number, total: number) => void): SoundBank {
    const bank = new SoundBank(), plan = bankPlan();
    plan.forEach((e, i) => { bank.add(f, e); onProgress?.(i + 1, plan.length); });
    return bank;
  }

  /** Renders everything, yielding to the event loop every `chunk` buffers so the loading screen stays live. */
  static async build(f: BufferFactory, onProgress?: (done: number, total: number) => void, chunk = 6): Promise<SoundBank> {
    const bank = new SoundBank(), plan = bankPlan();
    for (let i = 0; i < plan.length; i++) {
      bank.add(f, plan[i]);
      onProgress?.(i + 1, plan.length);
      if ((i + 1) % chunk === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
    return bank;
  }

  get(id: BankId, variant = 0): AudioBuffer | null {
    const list = this.buffers.get(id);
    if (!list || list.length === 0) return null;
    return list[((variant % list.length) + list.length) % list.length] ?? list[0];
  }

  variants(id: BankId): number { return this.buffers.get(id)?.length ?? 0; }
}
