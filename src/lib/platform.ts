export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

export const IS_WIN =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

/**
 * Window can show what is behind it. macOS vibrancy and Windows acrylic blur
 * the desktop; Linux (Wayland) only gets plain alpha, since `backdrop-filter`
 * cannot reach outside the page and niri has no compositor blur.
 */
export const HAS_NATIVE_GLASS = true;

/** Only macOS exposes an adjustable backdrop blur radius (NSVisualEffectView).
 * Windows acrylic is fixed, and Wayland has no blur protocol at all. */
export const HAS_BLUR_RADIUS = IS_MAC;

export const MOD = IS_MAC ? "⌘" : "Ctrl+";
export const ALT = IS_MAC ? "⌥" : "Alt+";
export const SHIFT = IS_MAC ? "⇧" : "Shift+";
