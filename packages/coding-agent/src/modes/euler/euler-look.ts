/**
 * Euler's own skin: one brand colour, one spinner.
 *
 * The theme owns the palette. Euler adds the teal chevron from the logo and nothing else, so the ADE
 * has an identity without forking pi's themes — which is also why it keeps working under any theme
 * the user picks, and why custom theming can arrive later without rewriting this surface.
 */

import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";

/** Logo teal. The light variant is darker so it survives a light theme background. */
const TEAL_DARK = rgbColor(0x5e, 0xc8, 0xc8);
const TEAL_LIGHT = rgbColor(0x2c, 0x8a, 0x8a);

/** The chevron from the logo: the cursor Euler leaves on every pane it owns. */
export const BRAND_MARK = "❯";

/**
 * Paint text in Euler teal. The reset is foreground-only, so brand text composes inside themed
 * backgrounds (`selectedBg`, tool boxes) instead of punching a hole in them.
 */
export function brand(text: string): string {
	const color = theme.appearance === "light" ? TEAL_LIGHT : TEAL_DARK;
	return `${foregroundAnsi(color, theme.getColorMode())}${text}\x1b[39m`;
}

/** Braille spinner, shared by the statusline and the rail so both beat together. */
export const SPINNER_INTERVAL_MS = 90;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Frame for the current instant: components stay stateless and only re-render on a tick. */
export function spinnerFrame(now = Date.now()): string {
	return SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length] ?? "⠋";
}
