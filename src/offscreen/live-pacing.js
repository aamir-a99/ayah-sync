// Leave breathing room after inference on slower CPUs. No queued work: the
// next submission always uses the most recent audio, never an old backlog.
export function recognitionCooldown(inferenceMs) {
  return Math.min(5000, Math.max(2000, Math.max(0, Number(inferenceMs) || 0) * 0.5));
}
