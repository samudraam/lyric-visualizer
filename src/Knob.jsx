import { useEffect, useRef } from 'react';

// Rotary dial for a 0..max value (used as a volume/gain control).
// - drag up/down to turn (DRAG_PIXELS of travel = the full range)
// - scroll wheel or arrow keys to nudge; Home/End jump to min/max
// - double-click to reset to defaultValue
// Exposed to assistive tech as a slider (role/aria-value*).
const DRAG_PIXELS = 160;
const SWEEP_DEGREES = 270; // the arc runs from -135° (min) to +135° (max)
const SIZE = 44;
const RADIUS = 17;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// Point on the dial's circle at `deg` (0° = straight up, clockwise).
function polar(deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [SIZE / 2 + RADIUS * Math.cos(rad), SIZE / 2 + RADIUS * Math.sin(rad)];
}

function arcPath(fromDeg, toDeg) {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x2} ${y2}`;
}

export default function Knob({ label, value, onChange, min = 0, max = 1.5, defaultValue = 1, step = 0.05, color = '#E14F84' }) {
  const ref = useRef(null);
  // Latest props for the native wheel listener, which is attached once.
  const latest = useRef({ value, onChange, min, max, step });
  useEffect(() => {
    latest.current = { value, onChange, min, max, step };
  });

  // React's onWheel is passive (can't preventDefault), so the page would
  // scroll while turning the dial; attach a non-passive listener instead.
  useEffect(() => {
    const el = ref.current;
    const onWheel = (e) => {
      e.preventDefault();
      const { value: v, onChange: change, min: lo, max: hi, step: s } = latest.current;
      change(clamp(v + (e.deltaY < 0 ? s : -s), lo, hi));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ref.current.focus();
    const startY = e.clientY;
    const startValue = value;
    const onMove = (ev) => {
      const delta = ((startY - ev.clientY) / DRAG_PIXELS) * (max - min);
      onChange(clamp(startValue + delta, min, max));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleKeyDown = (e) => {
    const moves = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step };
    if (e.key in moves) onChange(clamp(value + moves[e.key], min, max));
    else if (e.key === 'Home') onChange(min);
    else if (e.key === 'End') onChange(max);
    else return;
    e.preventDefault();
  };

  const startDeg = -SWEEP_DEGREES / 2;
  const valueDeg = startDeg + ((value - min) / (max - min)) * SWEEP_DEGREES;
  const [px, py] = polar(valueDeg);
  const percent = Math.round(value * 100);

  return (
    <div className="flex items-center gap-2 select-none">
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        title={`${label}: ${percent}% · drag, scroll or use arrow keys · double-click to reset`}
        onPointerDown={handlePointerDown}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={handleKeyDown}
        className="cursor-ns-resize rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        style={{ touchAction: 'none' }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS - 5} className="fill-panel-2" />
          <path d={arcPath(startDeg, -startDeg)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3.5" strokeLinecap="round" />
          {value > min && (
            <path d={arcPath(startDeg, valueDeg)} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" />
          )}
          <line x1={SIZE / 2} y1={SIZE / 2} x2={px} y2={py} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] text-text-dim uppercase tracking-wide">{label}</span>
        <span className="text-xs tabular-nums">{percent}%</span>
      </div>
    </div>
  );
}
