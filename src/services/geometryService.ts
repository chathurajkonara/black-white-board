import type { ParsedCommand, Point, ExistingShapeContext } from './nlpService';
import { AI_WIDTH } from '../constants';

export interface Shape {
  points: Point[];
  color: string;
  type: 'polygon' | 'circle' | 'sector';
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  label?: string;
  // Parallel to `points` for a polygon - edgeLabels[i] labels the edge from
  // points[i] to the next point. Plain text (e.g. "10 cm"), not geometry, so
  // it passes through unscaled.
  edgeLabels?: string[];
  // Parallel to `points` for a polygon - angleLabels[i] labels the interior
  // angle at points[i], e.g. "30°".
  angleLabels?: string[];
  // A stated real-world size for a circle/sector, e.g. "d = 4 cm".
  sizeLabel?: string;
}

// How far past a shape's own geometric edge/vertex a label can be drawn
// (see labelPlacement.ts's LABEL_MARGIN/LABEL_SEARCH_RANGE) - only applied
// to whichever side(s) actually exceed the nominal page, so a label isn't
// clipped right at the new edge the instant a shape just barely pokes past
// the boundary.
const CONTENT_PADDING = 100;

// A sketch is normally expected to stay within the AI's own 0-1000/
// 0-AI_HEIGHT coordinate space (which maps 1:1 onto canvasWidth x
// canvasHeight), but shapes built relative to existing ones across many
// commands can legitimately drift past that, or a circle/sector near an
// edge can mathematically poke past it. Returns the smallest box that
// still covers everything actually drawn - exactly {0, 0, canvasWidth,
// canvasHeight} when nothing overflows, so callers get zero behavior
// change for the common case.
export const computeContentBounds = (shapes: Shape[], canvasWidth: number, canvasHeight: number) => {
  let rawMinX = 0, rawMinY = 0, rawMaxX = canvasWidth, rawMaxY = canvasHeight;
  shapes.forEach(shape => {
    if ((shape.type === 'circle' || shape.type === 'sector') && shape.radius != null) {
      const c = shape.points[0];
      rawMinX = Math.min(rawMinX, c.x - shape.radius);
      rawMaxX = Math.max(rawMaxX, c.x + shape.radius);
      rawMinY = Math.min(rawMinY, c.y - shape.radius);
      rawMaxY = Math.max(rawMaxY, c.y + shape.radius);
    } else {
      shape.points.forEach(p => {
        rawMinX = Math.min(rawMinX, p.x);
        rawMaxX = Math.max(rawMaxX, p.x);
        rawMinY = Math.min(rawMinY, p.y);
        rawMaxY = Math.max(rawMaxY, p.y);
      });
    }
  });
  return {
    minX: rawMinX < 0 ? rawMinX - CONTENT_PADDING : 0,
    minY: rawMinY < 0 ? rawMinY - CONTENT_PADDING : 0,
    maxX: rawMaxX > canvasWidth ? rawMaxX + CONTENT_PADDING : canvasWidth,
    maxY: rawMaxY > canvasHeight ? rawMaxY + CONTENT_PADDING : canvasHeight,
  };
};

export const generateShapesFromAI = (command: ParsedCommand, canvasWidth: number): Shape[] => {
  // A single uniform scale (from canvas WIDTH only) for both x and y, so the
  // AI's 0-1000/0-AI_HEIGHT coordinate space maps onto the canvas without
  // distortion - equal x/y extents in that space stay equal in pixels,
  // regardless of the canvas's own aspect ratio.
  const scale = canvasWidth / AI_WIDTH;

  return command.shapes.map(aiShape => {
    if (aiShape.type === 'circle') {
      return {
        type: 'circle',
        points: [mapPoint(aiShape.center, scale)],
        radius: aiShape.radius * scale,
        sizeLabel: aiShape.sizeLabel,
        color: aiShape.color,
        label: aiShape.label
      };
    } else if (aiShape.type === 'sector') {
      return {
        type: 'sector',
        // Same center-mapping and radius-scaling as 'circle' above - a
        // sector sharing a circle's exact center/radius from the model
        // therefore always lands on the identical pixel arc.
        points: [mapPoint(aiShape.center, scale)],
        radius: aiShape.radius * scale,
        startAngle: aiShape.startAngle,
        endAngle: aiShape.endAngle,
        sizeLabel: aiShape.sizeLabel,
        color: aiShape.color,
        label: aiShape.label
      };
    } else {
      return {
        type: 'polygon',
        points: aiShape.points.map(p => mapPoint(p, scale)),
        edgeLabels: aiShape.edgeLabels,
        angleLabels: aiShape.angleLabels,
        color: aiShape.color,
        label: aiShape.label
      };
    }
  });
};

const mapPoint = (point: Point, scale: number): Point => {
  return {
    x: point.x * scale,
    y: point.y * scale,
    name: point.name
  };
};

// Inverse of generateShapesFromAI's mapping - converts shapes already on the
// board (pixel space) back into the AI's own coordinate space, so they can
// be handed back as context on the next command. Includes each shape's full
// geometry (not just label/type/color) so the model can read off an
// existing shape's actual size/position - and any stated real-world size
// (sizeLabel/edgeLabels) - when a new command describes a shape relative to
// it (e.g. "a 5cm circle in the middle of that 10cm square").
export const shapesToAIContext = (shapes: Shape[], canvasWidth: number): ExistingShapeContext[] => {
  const scale = canvasWidth / AI_WIDTH;
  return shapes.map(shape => ({
    type: shape.type,
    label: shape.label,
    color: shape.color,
    points: shape.points.map(p => ({ x: p.x / scale, y: p.y / scale, name: p.name })),
    radius: shape.radius != null ? shape.radius / scale : undefined,
    startAngle: shape.startAngle,
    endAngle: shape.endAngle,
    sizeLabel: shape.sizeLabel,
    edgeLabels: shape.edgeLabels,
    angleLabels: shape.angleLabels,
  }));
};
