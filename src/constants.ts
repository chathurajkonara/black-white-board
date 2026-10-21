export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

// The AI reasons in a fixed coordinate space with x spanning 0-1000. y spans
// 0-AI_HEIGHT using that SAME per-unit scale (derived from canvas width, not
// canvas height) so a shape with equal x/y extents in that space is an
// actual square on screen, rather than being stretched to the canvas's
// aspect ratio.
export const AI_WIDTH = 1000;
export const AI_HEIGHT = Math.round(AI_WIDTH * (CANVAS_HEIGHT / CANVAS_WIDTH));

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.25;

// Pixels scrolled per "scroll up/down/left/right" voice command, in the
// canvas viewport's own (already-zoomed) pixel space.
export const PAN_STEP = 120;
