import { useEffect, useState } from 'react';
import { GripHorizontal, X } from 'lucide-react';

// A fixed-position tool window: drag it by its title bar, resize it from the
// bottom-right corner. Position and size are remembered per browser (a
// viewer convenience, so plain localStorage), and always clamped back onto
// the screen so it can't get lost off an edge after a window resize.
const MIN_W = 260;
const MIN_H = 200;
const EDGE = 8; // gap kept between the panel and the viewport edge

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function defaultRect() {
  const w = 320;
  const h = Math.min(560, window.innerHeight - 96);
  return { x: window.innerWidth - w - 20, y: 80, w, h };
}

function fitToViewport(r) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = clamp(r.w, MIN_W, Math.max(MIN_W, vw - EDGE * 2));
  const h = clamp(r.h, MIN_H, Math.max(MIN_H, vh - EDGE * 2));
  return { w, h, x: clamp(r.x, EDGE, Math.max(EDGE, vw - w - EDGE)), y: clamp(r.y, EDGE, Math.max(EDGE, vh - h - EDGE)) };
}

function loadRect(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(saved[k]))) return fitToViewport(saved);
  } catch {
    // unreadable or blocked storage: fall through to the default spot
  }
  return fitToViewport(defaultRect());
}

export default function FloatingPanel({ title, icon, onClose, storageKey, children }) {
  const [rect, setRect] = useState(() => loadRect(storageKey));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(rect));
    } catch {
      // storage unavailable; the panel just won't remember its spot
    }
  }, [rect, storageKey]);

  useEffect(() => {
    const onResize = () => setRect((r) => fitToViewport(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Shared drag plumbing for moving and resizing: `apply` maps the pointer's
  // total offset since pointerdown onto the starting rect.
  const startPointerDrag = (e, apply) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = rect; // handlers are re-created each render, so this is current
    const onMove = (ev) => setRect(fitToViewport(apply(start, ev.clientX - startX, ev.clientY - startY)));
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleMoveDown = (e) => {
    if (e.target.closest('button')) return; // let the close button click
    startPointerDrag(e, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };

  const handleResizeDown = (e) => {
    e.stopPropagation();
    startPointerDrag(e, (s, dx, dy) => ({ ...s, w: s.w + dx, h: s.h + dy }));
  };

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed z-50 flex flex-col bg-panel/95 backdrop-blur border border-white/10 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-white/10 cursor-move select-none touch-none"
        onPointerDown={handleMoveDown}
        onDoubleClick={() => setRect(fitToViewport(defaultRect()))}
        title="Drag to move · double-click to reset position"
      >
        {icon}
        <span className="text-[13px] font-semibold flex-1">{title}</span>
        <GripHorizontal size={14} className="text-text-dim" />
        <button
          className="p-1 rounded-md text-text-dim hover:text-text hover:bg-white/10 cursor-pointer"
          onClick={onClose}
          aria-label={`Close ${title}`}
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">{children}</div>
      <div
        className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize touch-none"
        onPointerDown={handleResizeDown}
        title="Drag to resize"
      >
        <svg viewBox="0 0 16 16" className="w-full h-full text-text-dim">
          <path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
