import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/** ms the button is held before the picture shows large */
const HOLD = 350;

/**
 * A picture shown large while its tile is held down, as on the iPhone; a short click still picks. The click that
 * ends a hold picks nothing.
 */
export function usePressPreview<T>() {
  const [viewing, setViewing] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** the press under way became a hold */
  const held = useRef(false);

  const release = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setViewing(null);
  }, []);
  useEffect(() => release, [release]);

  /** What a tile needs: start a hold on press, end it on release or when the pointer leaves. */
  const pressable = (item: T) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      held.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        held.current = true;
        setViewing(item);
      }, HOLD);
    },
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: release,
  });

  /** True for the click that ends a hold: it must not pick. */
  const endedHold = () => {
    const was = held.current;
    held.current = false;
    return was;
  };

  return { viewing, pressable, endedHold };
}
