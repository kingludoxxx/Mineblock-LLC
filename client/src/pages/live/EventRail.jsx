// EventRail — the scrolling activity feed.
//
// Now a thin shell over RailCards (the card kit) + livePresentation
// (diffFreshIds). The helpers this file used to export — timeAgo, fmtMoney,
// useTick — moved to livePresentation.js and useTick.js: exporting them
// alongside a component tripped react-refresh/only-export-components, which
// was a standing lint error here.
import { useEffect, useRef, useState } from 'react';
import { RailCard, RailEmpty } from './RailCards';
import { diffFreshIds, FRESH_MS } from './livePresentation.js';
import useTick from './useTick';

export default function EventRail({ feed, connected = true }) {
  useTick(5000); // relative timestamps stay honest without new data

  // Which rows arrived since the last render, so they can flash once.
  const [fresh, setFresh] = useState(() => new Set());
  // null (not []) is the first-paint sentinel — see diffFreshIds. With [] the
  // whole backfilled feed would count as new and the rail would light up
  // entirely on load.
  const prevIdsRef = useRef(null);
  const timersRef = useRef(new Map());

  useEffect(() => {
    const { ids, fresh: added } = diffFreshIds(prevIdsRef.current, feed);
    prevIdsRef.current = ids;
    if (added.length === 0) return;

    setFresh((prev) => {
      const next = new Set(prev);
      for (const id of added) next.add(id);
      return next;
    });

    const timers = timersRef.current;
    for (const id of added) {
      // Re-arming an existing id would leak the previous timer.
      const existing = timers.get(id);
      if (existing) clearTimeout(existing);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        setFresh((prev) => {
          if (!prev.has(id)) return prev; // no state churn if it already went
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, FRESH_MS));
    }
  }, [feed]);

  // Unmount / funnel switch: every pending flash timer dies with the component.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  if (!feed || feed.length === 0) return <RailEmpty connected={connected} />;

  return (
    <ul
      className="space-y-2 overflow-y-auto pr-1"
      style={{ maxHeight: 'calc(100vh - 260px)' }}
      data-testid="lv-rail"
    >
      {feed.map((ev) => (
        <RailCard key={ev.id} ev={ev} fresh={fresh.has(ev.id)} />
      ))}
    </ul>
  );
}
