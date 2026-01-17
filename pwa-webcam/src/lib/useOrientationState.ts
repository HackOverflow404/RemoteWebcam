import { useEffect, useState } from "react";

type OrientationState = {
  isLandscape: boolean;
  angle: number; // best-effort 0/90/180/270
  vw: number; // pixels
  vh: number; // pixels
};

const normalize = (deg: number) => ((deg % 360) + 360) % 360;

export default function useOrientationState(): OrientationState {
  const [state, setState] = useState<OrientationState>(() => ({
    isLandscape: false,
    angle: 0,
    vw: 0,
    vh: 0,
  }));

  useEffect(() => {
    let raf = 0;

    const getViewport = () => {
      const vv = window.visualViewport;
      const vw = vv?.width ?? window.innerWidth;
      const vh = vv?.height ?? window.innerHeight;
      return { vw, vh };
    };

    const getIsLandscape = () =>
      window.matchMedia?.("(orientation: landscape)")?.matches ??
      window.innerWidth > window.innerHeight;

    const getAngleBestEffort = (isLandscape: boolean) => {
      // Prefer iOS Safari’s legacy window.orientation when present
      const w = window as unknown as { orientation?: number };
      if (typeof w.orientation === "number") return normalize(w.orientation);

      // Sometimes available elsewhere
      const so = window.screen?.orientation;
      if (so && typeof so.angle === "number") return normalize(so.angle);

      // Fallback: we only really need portrait vs landscape for your layout
      return isLandscape ? 90 : 0;
    };

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const isLandscape = getIsLandscape();
        const angle = getAngleBestEffort(isLandscape);
        const { vw, vh } = getViewport();

        // Feed your React state
        setState({ isLandscape, angle, vw, vh });

        // Also set CSS vars to avoid iOS PWA viewport unit weirdness
        document.documentElement.style.setProperty("--app-vw", `${vw}px`);
        document.documentElement.style.setProperty("--app-vh", `${vh}px`);
      });
    };

    // iOS can report “in-between” sizes during the rotation animation; do 2 passes
    const updateSoon = () => {
      update();
      setTimeout(update, 80);
      setTimeout(update, 250);
    };

    updateSoon();

    window.addEventListener("resize", updateSoon, { passive: true });
    window.addEventListener("orientationchange", updateSoon, { passive: true });
    window.visualViewport?.addEventListener("resize", updateSoon, {
      passive: true,
    });

    // When returning to app from background, iOS PWAs often need a refresh
    window.addEventListener("pageshow", updateSoon, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateSoon();
    });

    // ScreenOrientation API (helps on non-iOS)
    window.screen?.orientation?.addEventListener?.("change", updateSoon);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateSoon);
      window.removeEventListener("orientationchange", updateSoon);
      window.visualViewport?.removeEventListener("resize", updateSoon);
      window.removeEventListener("pageshow", updateSoon);
      window.screen?.orientation?.removeEventListener?.("change", updateSoon);
    };
  }, []);

  return state;
}
