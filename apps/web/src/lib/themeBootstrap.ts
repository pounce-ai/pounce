/**
 * The theme bootstrap, as source text, so the hand-built pages and the Starlight
 * docs run byte-identical logic.
 *
 * It has to be inlined in <head> and run before first paint, which rules out an
 * external module. Both call sites need it, and two hand-kept copies of a
 * pre-paint script is exactly the kind of thing that drifts, so it lives here
 * and is injected by BaseHead.astro and by the `head` entry in astro.config.mjs.
 *
 * Two jobs:
 *
 * 1. Settle the theme. The site has light and dark only, light is the default,
 *    and Starlight's own provider falls back to the OS when nothing is stored —
 *    so writing the value makes both surfaces agree in either script order.
 *
 * 2. Re-apply it after a view transition. `astro:after-swap` fires on the new
 *    document *before* it paints. This is not optional: the swap copies the
 *    incoming document's <html> attributes over the live ones, and the incoming
 *    document is static HTML that never carried data-theme — so without this a
 *    dark-mode visitor snaps back to light on every navigation.
 *
 * The listener is registered on `document`, which survives swaps, so it is added
 * once and guarded against re-registration when this script runs again.
 */
export const THEME_BOOTSTRAP = `(() => {
  var apply = function () {
    try {
      var stored = localStorage.getItem("starlight-theme");
      var theme = stored === "dark" ? "dark" : "light";
      if (stored !== theme) localStorage.setItem("starlight-theme", theme);
      var root = document.documentElement;
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      // Painted here as well as in CSS: a real navigation lets the browser show
      // its white default before the stylesheet applies, which is a white flash
      // on every click in dark mode.
      root.style.backgroundColor = theme === "dark" ? "#17111f" : "#fef1e3";
    } catch (e) {}
  };
  apply();
  if (!window.__pounceThemeBound) {
    window.__pounceThemeBound = true;
    document.addEventListener("astro:after-swap", apply);
  }
})();`;
