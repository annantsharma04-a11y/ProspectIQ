'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A floating info tooltip.
 *
 * Two earlier versions were wrong in instructive ways. The first was a
 * `<span title>`, which needs a second of hover, does nothing on touch, and is
 * not reliably announced. The second was an absolutely-positioned span inside
 * the card, which inherited `text-transform: uppercase` from headings, was
 * clipped by panels with `overflow-hidden`, could not escape the card's
 * stacking context, and always opened downward — directly over the content the
 * reader was trying to understand.
 *
 * This renders through a PORTAL on document.body with `position: fixed`, so no
 * ancestor's overflow, transform or z-index can affect it. Placement is
 * measured against the viewport: above the icon when there is room, below when
 * there is not, and clamped horizontally so it can never cause a horizontal
 * scrollbar.
 *
 * No new dependency: createPortal ships with React.
 */

/** Only one tooltip may be open. Closing the previous one is the whole trick. */
let closeActive: (() => void) | null = null;

const MAX_WIDTH = 320;
/** Keep this much clear of every viewport edge. */
const MARGIN = 16;
/** Space between the icon and the tooltip. */
const GAP = 8;

export interface Position {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/**
 * Where the tooltip goes, in viewport coordinates.
 *
 * Pure, so the placement rules are testable without a DOM: prefer above the
 * icon, fall back to below, and clamp horizontally so the tooltip can never
 * extend past the viewport and create a horizontal scrollbar.
 */
export function computePosition(
  anchor: Rect,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): Position {
  const fitsAbove = anchor.top - tip.height - GAP >= MARGIN;
  const placement: Position['placement'] = fitsAbove ? 'above' : 'below';

  const top = fitsAbove
    ? anchor.top - tip.height - GAP
    : Math.min(anchor.bottom + GAP, viewport.height - tip.height - MARGIN);

  // Centre on the icon, then clamp inside the viewport. Math.max last so a
  // tooltip wider than the viewport still starts at the left margin.
  const ideal = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(ideal, viewport.width - tip.width - MARGIN));

  return { top, left, placement };
}

export default function InfoTip({
  label,
  definition,
}: {
  /** What is being explained; used to build the accessible name. */
  label: string;
  /** One or two sentences. Never render this component with an empty string. */
  definition: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    if (closeActive) closeActive = null;
  }, []);

  const show = useCallback(() => {
    // Never leave two open at once.
    if (closeActive) closeActive();
    closeActive = () => setOpen(false);
    // Clear the previous measurement here, not in the effect, so the tooltip is
    // never painted at a stale position while the new one is measured.
    setPos(null);
    setOpen(true);
  }, []);

  // Measure after render, before paint, so the tooltip never flashes in the
  // wrong place. Falls back to below when there is no room above.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = buttonRef.current;
      const tip = tipRef.current;
      if (!btn || !tip) return;

      const b = btn.getBoundingClientRect();
      const { width, height } = tip.getBoundingClientRect();

      setPos(
        computePosition(
          { top: b.top, bottom: b.bottom, left: b.left, width: b.width },
          { width, height },
          {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          },
        ),
      );
    };

    place();
    // Reposition rather than drift when the page moves under it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !tipRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Unmounting while open must not leave the singleton pointing at a dead node.
  useEffect(() => () => { if (closeActive) closeActive = null; }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Explain ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => (open ? close() : show())}
        onMouseEnter={show}
        onMouseLeave={close}
        onFocus={show}
        onBlur={close}
        className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] font-medium normal-case leading-none tracking-normal text-slate-400 transition-colors hover:border-indigo-400 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        i
        {/* Always available to assistive technology, open or not. */}
        <span className="sr-only">. {definition}</span>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxWidth: `min(${MAX_WIDTH}px, calc(100vw - ${MARGIN * 2}px))`,
              // Hidden until measured, so it never paints at the fallback spot.
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="z-[100] rounded-lg bg-slate-900 px-3 py-2 text-left text-[13px] font-normal normal-case leading-[1.45] tracking-normal text-slate-100 shadow-xl"
          >
            {definition}
          </div>,
          document.body,
        )}
    </>
  );
}
