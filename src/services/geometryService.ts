import type { ParsedCommand, AIShape, Point } from './nlpService';

export interface Shape {
  points: Point[];
  color: string;
  type: 'polygon' | 'circle';
  radius?: number;
  label?: string;
}

export const generateShapesFromAI = (command: ParsedCommand, canvasWidth: number, canvasHeight: number): Shape[] => {
  return command.shapes.map(aiShape => {
    if (aiShape.type === 'circle' && aiShape.center) {
      return {
        type: 'circle',
        points: [mapPoint(aiShape.center, canvasWidth, canvasHeight)],
        radius: (aiShape.radius || 50) * (canvasWidth / 1000),
        color: aiShape.color,
        label: aiShape.label
      };
    } else {
      return {
        type: 'polygon',
        points: (aiShape.points || []).map(p => mapPoint(p, canvasWidth, canvasHeight)),
        color: aiShape.color,
        label: aiShape.label
      };
    }
  });
};

const mapPoint = (point: Point, width: number, height: number): Point => {
  return {
    x: (point.x / 1000) * width,
    y: (point.y / 1000) * height
  };
};
