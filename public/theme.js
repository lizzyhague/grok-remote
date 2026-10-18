/* Resolve the theme before styles load to avoid a dark-color flash. */
(function () {
  var KEY = "grok-remote.theme";
  // Page background of each theme, so the PWA status bar and title bar match the page; kept in step with styles.css by page-colors.test.js.
  var HEADER_COLORS = { dark: "#161413", light: "#f8f4ea" };
  var root = document.documentElement;
  var header = document.querySelector('meta[name="theme-color"]');
  var media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  var choice = read();

  function normalize(value) {
    return value === "light" || value === "dark" ? value : "system";
  }

  function read() {
    try { return normalize(localStorage.getItem(KEY)); }
    catch (error) { return "system"; }
  }

  function apply() {
    var theme = choice === "system" ? (media && media.matches ? "light" : "dark") : choice;
    root.setAttribute("data-theme", theme);
    if (header) header.setAttribute("content", HEADER_COLORS[theme]);
  }

  apply();
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", apply);
    else if (typeof media.addListener === "function") media.addListener(apply);
  }
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY && event.key !== null) return;
    choice = read();
    apply();
  });

  window.grokRemoteTheme = {
    get: function () { return choice; },
    set: function (value) {
      choice = normalize(value);
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch (error) {
        // The choice still applies to this page when storage is unavailable.
      }
      apply();
    },
  };
}());
