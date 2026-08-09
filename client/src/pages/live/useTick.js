// useTick — re-render on an interval so relative timestamps stay honest
// without new data arriving.
//
// Lives in its own file rather than beside a component: a module that exports
// both a component and a hook trips react-refresh/only-export-components,
// which was a standing lint error on this page.
//
// The interval is cleared on unmount AND parked while the tab is hidden — a
// board left open in a background tab should not wake the main thread every
// five seconds to recompute "3m ago" that nobody is reading.
import { useEffect, useState } from 'react';

export default function useTick(ms = 5000) {
  const [, setN] = useState(0);

  useEffect(() => {
    const period = Number.isFinite(ms) && ms > 0 ? ms : 5000;
    let timer = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => setN((n) => n + 1), period);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately — the labels are stale by however long the tab
        // was away, and waiting a full period to correct them is visible.
        setN((n) => n + 1);
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}
