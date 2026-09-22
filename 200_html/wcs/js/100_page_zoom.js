(function () {
  const decreaseButton = document.getElementById("page-zoom-decrease");
  const increaseButton = document.getElementById("page-zoom-increase");
  const valueLabel = document.getElementById("page-zoom-value");

  if (!decreaseButton || !increaseButton || !valueLabel) {
    return;
  }

  const ZOOM_STORAGE_KEY = "wcs.vehicleStatus.pageZoomPercent";
  const ZOOM_STEP_PERCENT = 5;
  const ZOOM_MIN_PERCENT = 40;
  const ZOOM_MAX_PERCENT = 150;
  const TABLET_DEFAULT_ZOOM_PERCENT = 67;
  const DESKTOP_DEFAULT_ZOOM_PERCENT = 100;
  // Android's own resource-qualifier breakpoint (sw600dp) for "this is a tablet, not a
  // phone" - screen.width/height are physical CSS px, unaffected by this page's own
  // portrait-forcing rotation (100_vehicle_status.css), so the shorter of the two is a
  // stable stand-in for the device's short edge regardless of current orientation.
  const TABLET_MIN_SHORT_SIDE_PX = 600;

  function isLargeAndroidTablet() {
    const isAndroid = /Android/i.test(navigator.userAgent || "");
    if (!isAndroid) {
      return false;
    }

    const shortSidePx = Math.min(
      Number(window.screen?.width) || 0,
      Number(window.screen?.height) || 0,
    );
    return shortSidePx >= TABLET_MIN_SHORT_SIDE_PX;
  }

  function clampZoomPercent(percent) {
    return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, percent));
  }

  function getDefaultZoomPercent() {
    return isLargeAndroidTablet()
      ? TABLET_DEFAULT_ZOOM_PERCENT
      : DESKTOP_DEFAULT_ZOOM_PERCENT;
  }

  function loadZoomPercent() {
    try {
      if (typeof window.localStorage === "undefined") {
        return getDefaultZoomPercent();
      }

      const savedValue = window.localStorage.getItem(ZOOM_STORAGE_KEY);
      if (savedValue == null) {
        return getDefaultZoomPercent();
      }

      const parsedValue = Number.parseInt(savedValue, 10);
      return Number.isFinite(parsedValue)
        ? clampZoomPercent(parsedValue)
        : getDefaultZoomPercent();
    } catch (error) {
      return getDefaultZoomPercent();
    }
  }

  function saveZoomPercent(percent) {
    try {
      if (typeof window.localStorage === "undefined") {
        return;
      }
      window.localStorage.setItem(ZOOM_STORAGE_KEY, String(percent));
    } catch (error) {
      // Ignore storage write errors in restricted browser modes.
    }
  }

  let currentZoomPercent = clampZoomPercent(loadZoomPercent());

  function applyZoomPercent(percent) {
    // Setting `zoom` on <html> (not <body> or some inner wrapper) is what makes Chrome
    // treat it as a real page zoom - vh/vw/100% layout throughout the page recompute
    // against the rescaled effective viewport, the same as the browser's own Ctrl+-/
    // pinch zoom, so content actually gains/loses screen real estate instead of just
    // rendering smaller inside an unchanged-size box.
    document.documentElement.style.zoom = `${percent}%`;
    valueLabel.textContent = `${percent}%`;
    decreaseButton.disabled = percent <= ZOOM_MIN_PERCENT;
    increaseButton.disabled = percent >= ZOOM_MAX_PERCENT;
  }

  function setZoomPercent(nextPercent) {
    currentZoomPercent = clampZoomPercent(nextPercent);
    saveZoomPercent(currentZoomPercent);
    applyZoomPercent(currentZoomPercent);
  }

  applyZoomPercent(currentZoomPercent);

  decreaseButton.addEventListener("click", () => {
    setZoomPercent(currentZoomPercent - ZOOM_STEP_PERCENT);
  });
  increaseButton.addEventListener("click", () => {
    setZoomPercent(currentZoomPercent + ZOOM_STEP_PERCENT);
  });
})();
