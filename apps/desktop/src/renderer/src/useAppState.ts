import { useEffect, useState } from "react";
import type { AppEvent, AppSnapshot } from "@turbodl/shared";
import { api } from "./api";
import { applyEvent } from "./state";

export function useAppState(): AppSnapshot | null {
  const [state, setState] = useState<AppSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded = false;
    const early: AppEvent[] = [];
    const off = api.onEvent((event) => {
      if (!loaded) early.push(event);
      else setState((s) => (s ? applyEvent(s, event) : s));
    });
    void api.getSnapshot().then((snapshot) => {
      if (!alive) return;
      loaded = true;
      setState(early.reduce(applyEvent, snapshot));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
