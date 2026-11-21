export function buzz(pattern: number | number[] = 20) {
  try { navigator.vibrate?.(pattern) } catch { /* unsupported */ }
}

let ctx: AudioContext | null = null
export function chime(kind: 'ok' | 'alert' | 'remove' | 'fail' = 'ok') {
  try {
    ctx ??= new AudioContext()
    const t = ctx.currentTime
    const notes =
      kind === 'ok' ? [660, 990] : kind === 'alert' ? [880, 1320, 880, 1320] : kind === 'remove' ? [520, 390] : [220]
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator()
      const g = ctx!.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + i * 0.09)
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.09 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16)
      o.connect(g).connect(ctx!.destination)
      o.start(t + i * 0.09)
      o.stop(t + i * 0.09 + 0.18)
    })
  } catch { /* no audio */ }
}
