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
