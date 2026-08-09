// SaleAlertControls — the operator's sound switch + volume, in the top bar.
//
// Port of funnel-os's SaleAlertControls.jsx onto Puure's dark tokens, with the
// volume slider it never had. Three states are visible rather than implied:
//   • LOCKED  — the browser is waiting for a gesture. An explicit "Enable
//               sound" pill, because silently doing nothing is how an operator
//               concludes the feature is broken.
//   • ON      — speaker icon + slider.
//   • MUTED   — crossed speaker; the slider stays visible but disabled, so the
//               remembered level is still legible.
// `unsupported` renders nothing at all — there is no honest control to offer.
import { Volume2, VolumeX } from 'lucide-react';

export default function SaleAlertControls({ sound, compact = false }) {
  if (!sound || !sound.supported) return null;

  const pct = Math.round((sound.volume ?? 0) * 100);

  if (sound.needsUnlock) {
    return (
      <button
        type="button"
        onClick={sound.enable}
        data-testid="lv-sound-unlock"
        title="Your browser blocks sound until you interact with the page. Click to enable sale alerts."
        className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-accent/50 bg-accent-muted px-3 text-[12px] text-accent-text transition-colors hover:border-accent"
      >
        <Volume2 className="h-3.5 w-3.5" />
        {compact ? null : 'Enable sound'}
      </button>
    );
  }

  return (
    <div
      className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-border-default bg-bg-elevated px-2.5"
      data-testid="lv-alert-controls"
    >
      <button
        type="button"
        onClick={sound.toggleMute}
        onDoubleClick={sound.muted ? undefined : sound.test}
        aria-pressed={!sound.muted}
        aria-label={sound.muted ? 'Unmute sale alerts' : 'Mute sale alerts'}
        title={sound.muted
          ? 'Sale alerts muted — click to unmute'
          : 'Sale alerts on — click to mute, double-click to test'}
        data-testid="lv-sound-toggle"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
          sound.muted ? 'text-text-faint hover:text-text-muted' : 'text-accent-text hover:text-accent'
        }`}
      >
        {sound.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>

      <input
        type="range"
        min="0"
        max="100"
        step="5"
        value={pct}
        disabled={sound.muted}
        aria-label="Sale alert volume"
        title={`Sale alert volume — ${pct}%`}
        data-testid="lv-sound-volume"
        // onChange tracks the drag silently; onPointerUp/onKeyUp previews ONCE
        // from inside the gesture. Chiming on every onChange during a drag
        // would fire ~20 overlapping rings.
        onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
        onPointerUp={(e) => sound.previewVolume(Number(e.currentTarget.value) / 100)}
        onKeyUp={(e) => sound.previewVolume(Number(e.currentTarget.value) / 100)}
        className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-bg-active accent-accent disabled:cursor-not-allowed disabled:opacity-40"
      />
      {compact ? null : (
        <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-text-faint">
          {sound.muted ? 'off' : `${pct}%`}
        </span>
      )}
    </div>
  );
}
