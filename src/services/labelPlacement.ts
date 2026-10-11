// Geometry helpers for placing text labels on the canvas without them
// overlapping shape strokes or other labels. The approach is deliberately
// simple: sample points along segments/arcs rather than doing exact
// line-vs-rectangle intersection math, since the board only ever has a
// handful of shapes and sampling is cheap and easy to reason about.

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Arc {
  cx: number;
  cy: number;
  r: number;
  startRad: number;
  endRad: number;
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAMPLE_STEP_PX = 4;

export const makeLabelBox = (cx: number, cy: number, width: number, height: number): LabelBox => ({
  x: cx - width / 2,
  y: cy - height / 2,
  width,
  height,
});

const boxesOverlap = (a: LabelBox, b: LabelBox): boolean =>
  !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);

const pointInBox = (x: number, y: number, box: LabelBox): boolean =>
  x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

const segmentHitsBox = (seg: Segment, box: LabelBox): boolean => {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP_PX));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (pointInBox(seg.x1 + (seg.x2 - seg.x1) * t, seg.y1 + (seg.y2 - seg.y1) * t, box)) {
      return true;
    }
  }
  return false;
};

const arcHitsBox = (arc: Arc, box: LabelBox): boolean => {
  let sweep = arc.endRad - arc.startRad;
  if (sweep < 0) sweep += Math.PI * 2;
  const steps = Math.max(1, Math.ceil((arc.r * sweep) / SAMPLE_STEP_PX));
  for (let s = 0; s <= steps; s++) {
    const t = arc.startRad + sweep * (s / steps);
    if (pointInBox(arc.cx + Math.cos(t) * arc.r, arc.cy + Math.sin(t) * arc.r, box)) {
      return true;
    }
  }
  return false;
};

/**
 * Searches outward from `anchor` along direction (dirX, dirY) for the
 * nearest distance, between startDist and maxDist, whose label box clears
 * every segment, arc, and already-placed label box. Falls back to
 * startDist if nothing in range is clear - a slight overlap reads better
 * than a label stranded far from the feature it describes.
 */
export const findClearLabelSpot = (params: {
  text: string;
  measureWidth: number;
  lineHeight: number;
  anchorX: number;
  anchorY: number;
  dirX: number;
  dirY: number;
  startDist: number;
  maxDist: number;
  segments: Segment[];
  arcs: Arc[];
  placedBoxes: LabelBox[];
}): { x: number; y: number; box: LabelBox } => {
  const { measureWidth, lineHeight, anchorX, anchorY, dirX, dirY, startDist, maxDist, segments, arcs, placedBoxes } = params;
  const padding = 3;
  const boxWidth = measureWidth + padding * 2;
  const boxHeight = lineHeight + padding * 2;

  let fallback: { x: number; y: number; box: LabelBox } | null = null;
  for (let dist = startDist; dist <= maxDist; dist += SAMPLE_STEP_PX) {
    const x = anchorX + dirX * dist;
    const y = anchorY + dirY * dist;
    const box = makeLabelBox(x, y, boxWidth, boxHeight);
    if (!fallback) fallback = { x, y, box };
    const blocked =
      segments.some(seg => segmentHitsBox(seg, box)) ||
      arcs.some(arc => arcHitsBox(arc, box)) ||
      placedBoxes.some(placed => boxesOverlap(placed, box));
    if (!blocked) {
      return { x, y, box };
    }
  }
  return fallback as { x: number; y: number; box: LabelBox };
};
