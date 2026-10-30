// One AudioContext shared across pages (client-side navigation keeps it alive).
//
// iOS creates AudioContexts suspended and only lets them start from inside a
// user gesture. The stream page mounts after navigation, outside any gesture,
// so the context is created and resumed in the home page's "Start Stream"
// tap via unlockAudioContext(), and reused from there.

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  const Ctx = typeof window !== "undefined"
    ? window.AudioContext ?? (window as any).webkitAudioContext
    : undefined;
  if (!Ctx) return null;
  ctx = new Ctx() as AudioContext;
  return ctx;
}

/** Call synchronously inside a click/tap handler. */
export function unlockAudioContext(): void {
  const c = getAudioContext();
  if (c && c.state !== "running") void c.resume().catch(() => {});
}
