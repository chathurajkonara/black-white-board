import React, { useRef, useEffect, useState } from 'react';
import './App.css';
import useVoiceRecognition from './hooks/useVoiceRecognition';
import { parseCommand } from './services/nlpService';
import { generateShapesFromAI, shapesToAIContext } from './services/geometryService';
import type { Shape } from './services/geometryService';
import type { Point } from './services/nlpService';
import { MicIcon, StopIcon, TrashIcon, UndoIcon, AlertIcon } from './components/Icons';
import { findClearLabelSpot } from './services/labelPlacement';
import type { Segment, Arc, LabelBox } from './services/labelPlacement';
import { CANVAS_WIDTH, CANVAS_HEIGHT, AI_WIDTH } from './constants';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { text, commandQueue, isListening, startListening, stopListening, dequeueCommand } = useVoiceRecognition();
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Named vertices (e.g. "A", "B") derived from whatever is currently on the
  // board, in the AI's 0-1000 coordinate space. Deriving this from `shapes`
  // instead of tracking it separately means Undo/Clear keep it correct for
  // free - a name only exists here while its point is still drawn.
  const namedPoints = React.useMemo(() => {
    // Same uniform (width-derived) scale as generateShapesFromAI/
    // shapesToAIContext use, so a named point's reported coordinates line up
    // with the rest of the geometry handed back to the model.
    const scale = CANVAS_WIDTH / AI_WIDTH;
    const registry: Record<string, Point> = {};
    shapes.forEach(shape => {
      shape.points.forEach(point => {
        if (point.name) {
          registry[point.name] = {
            x: point.x / scale,
            y: point.y / scale,
          };
        }
      });
    });
    return registry;
  }, [shapes]);

  const drawShapes = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;

    // --- Pass 1: stroke every shape, collecting its geometry so labels in
    // pass 2 can be checked against ALL shapes' lines, not just their own -
    // two shapes placed close together can otherwise have one's label land
    // on the other's stroke. ---
    const segments: Segment[] = [];
    const arcs: Arc[] = [];

    shapes.forEach(shape => {
      ctx.strokeStyle = shape.color || 'black';

      if (shape.type === 'circle' && shape.radius) {
        const center = shape.points[0];
        ctx.beginPath();
        ctx.arc(center.x, center.y, shape.radius, 0, Math.PI * 2);
        ctx.stroke();
        arcs.push({ cx: center.x, cy: center.y, r: shape.radius, startRad: 0, endRad: Math.PI * 2 });
      } else if (shape.type === 'sector' && shape.radius != null && shape.startAngle != null && shape.endAngle != null) {
        const center = shape.points[0];
        // Same ctx.arc() primitive and pixel radius as the 'circle' branch
        // above - a sector sharing a circle's center/radius therefore draws
        // on the exact same curve as that circle, not an approximation.
        const startRad = (shape.startAngle * Math.PI) / 180;
        const endRad = (shape.endAngle * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.arc(center.x, center.y, shape.radius, startRad, endRad);
        ctx.closePath();
        ctx.stroke();
        arcs.push({ cx: center.x, cy: center.y, r: shape.radius, startRad, endRad });
        // The wedge's two straight sides are lines too.
        segments.push({
          x1: center.x, y1: center.y,
          x2: center.x + Math.cos(startRad) * shape.radius, y2: center.y + Math.sin(startRad) * shape.radius,
        });
        segments.push({
          x1: center.x, y1: center.y,
          x2: center.x + Math.cos(endRad) * shape.radius, y2: center.y + Math.sin(endRad) * shape.radius,
        });
      } else {
        ctx.beginPath();
        shape.points.forEach((point, index) => {
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.closePath();
        ctx.stroke();

        const vertexCount = shape.points.length;
        const edgeCount = vertexCount === 2 ? 1 : vertexCount;
        for (let i = 0; i < edgeCount; i++) {
          const p1 = shape.points[i];
          const p2 = shape.points[(i + 1) % vertexCount];
          segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
      }
    });

    // --- Pass 2: place every label, searching outward from its usual
    // anchor/direction until it clears every stroke collected above and
    // every label already placed this render (falls back to the closest
    // position tried if nothing in range is fully clear). ---
    ctx.fillStyle = '#111';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const LABEL_MARGIN = 14;
    // How much further a label may be pushed to dodge an overlap it finds.
    const LABEL_SEARCH_RANGE = 50;
    const LINE_HEIGHT = 16;
    // Cap on how far an angle label gets pushed in for a very sharp corner -
    // without this, a razor-thin angle would need an enormous inset to fully
    // clear both edges and the label would end up looking disconnected from
    // its corner.
    const MAX_ANGLE_LABEL_INSET = 70;
    // A reused point (e.g. a rectangle built "using B and C as base") shows
    // up in more than one shape's points array with the same name - only
    // label it once, at wherever it's first drawn.
    const labeledNames = new Set<string>();
    // Same idea for a shared edge: a rectangle built "using A and B as base"
    // reuses that exact segment, so if both shapes carry an edgeLabel for it
    // (e.g. both say "10 cm"), only the first one drawn should render - the
    // key is the edge's actual endpoint coordinates, not which shape it
    // came from, since that's what makes it "the same edge". Angle labels
    // are deliberately NOT deduped this way - the same vertex can have a
    // genuinely different interior angle in each shape it belongs to.
    const labeledEdges = new Set<string>();
    const pointKey = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`;
    const placedBoxes: LabelBox[] = [];

    const placeLabel = (
      text: string,
      anchorX: number, anchorY: number,
      dirX: number, dirY: number,
      startDist: number, maxDist: number
    ) => {
      const { x, y, box } = findClearLabelSpot({
        text,
        measureWidth: ctx.measureText(text).width,
        lineHeight: LINE_HEIGHT,
        anchorX, anchorY, dirX, dirY, startDist, maxDist,
        segments, arcs, placedBoxes,
      });
      ctx.fillText(text, x, y);
      placedBoxes.push(box);
    };

    shapes.forEach(shape => {
      if (shape.type === 'circle' && shape.radius) {
        const center = shape.points[0];
        // A circle only has its center point - push the label above the
        // circumference rather than the center itself. A stated size (e.g.
        // "d = 4 cm") goes below, so the two start on opposite sides.
        if (center.name && !labeledNames.has(center.name)) {
          labeledNames.add(center.name);
          const start = shape.radius + LABEL_MARGIN;
          placeLabel(center.name, center.x, center.y, 0, -1, start, start + LABEL_SEARCH_RANGE);
        }
        if (shape.sizeLabel) {
          const start = shape.radius + LABEL_MARGIN;
          placeLabel(shape.sizeLabel, center.x, center.y, 0, 1, start, start + LABEL_SEARCH_RANGE);
        }
      } else if (shape.type === 'sector' && shape.radius != null && shape.startAngle != null && shape.endAngle != null) {
        const center = shape.points[0];
        const startRad = (shape.startAngle * Math.PI) / 180;
        const endRad = (shape.endAngle * Math.PI) / 180;
        const midRad = (startRad + endRad) / 2;
        const dirX = Math.cos(midRad), dirY = Math.sin(midRad);

        if (center.name && !labeledNames.has(center.name)) {
          labeledNames.add(center.name);
          const start = shape.radius + LABEL_MARGIN;
          placeLabel(center.name, center.x, center.y, dirX, dirY, start, start + LABEL_SEARCH_RANGE);
        }
        if (shape.sizeLabel) {
          // Starts further out along the same bisecting ray as the name
          // label above, so the two start stacked instead of overlapping.
          const start = shape.radius + LABEL_MARGIN * (center.name ? 2.2 : 1);
          placeLabel(shape.sizeLabel, center.x, center.y, dirX, dirY, start, start + LABEL_SEARCH_RANGE);
        }
      } else {
        // Push each vertex label further out along the line from the
        // shape's centroid through that vertex, so it starts just outside
        // the sketch's corner instead of on top of the shape.
        const centroid = shape.points.reduce(
          (acc, p) => ({ x: acc.x + p.x / shape.points.length, y: acc.y + p.y / shape.points.length }),
          { x: 0, y: 0 }
        );
        shape.points.forEach(point => {
          if (!point.name || labeledNames.has(point.name)) return;
          labeledNames.add(point.name);
          const dx = point.x - centroid.x;
          const dy = point.y - centroid.y;
          const dist = Math.hypot(dx, dy) || 1;
          placeLabel(point.name, point.x, point.y, dx / dist, dy / dist, LABEL_MARGIN, LABEL_MARGIN + LABEL_SEARCH_RANGE);
        });

        // Label corners with a stated interior angle (e.g. "30°"), starting
        // INSIDE the polygon along that corner's real angle bisector (unlike
        // the name label above, which pushes outward) - reads as "the angle
        // at this corner" instead of floating outside the shape, and never
        // collides with the name since the two start on opposite sides of
        // the vertex. Unlike names, an angle is specific to this shape's own
        // corner, not a cross-shape identity, so it's never deduplicated.
        const vertexCount = shape.points.length;
        shape.points.forEach((point, index) => {
          const rawAngleLabel = shape.angleLabels?.[index];
          if (!rawAngleLabel) return;
          const trimmed = rawAngleLabel.trim();
          // Claude doesn't always include the ° symbol - append it whenever
          // the label is a bare number so it never renders as just "30".
          const angleLabel = /\d$/.test(trimmed) ? `${trimmed}°` : trimmed;

          // The two edges meeting at this vertex, and the angle between them.
          const prev = shape.points[(index - 1 + vertexCount) % vertexCount];
          const next = shape.points[(index + 1) % vertexCount];
          const len1 = Math.hypot(prev.x - point.x, prev.y - point.y) || 1;
          const len2 = Math.hypot(next.x - point.x, next.y - point.y) || 1;
          const u1x = (prev.x - point.x) / len1, u1y = (prev.y - point.y) / len1;
          const u2x = (next.x - point.x) / len2, u2y = (next.y - point.y) / len2;
          const interiorAngle = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));

          // Direction bisecting that angle, pointing into the polygon.
          let bx = u1x + u2x, by = u1y + u2y;
          const bLen = Math.hypot(bx, by);
          if (bLen < 1e-6) {
            // The two edges point opposite ways (a ~180° corner) - the
            // bisector is undefined, so fall back to a perpendicular.
            bx = -u1y; by = u1x;
          } else {
            bx /= bLen; by /= bLen;
          }

          // How far in the label needs to start for its full width to clear
          // both edges, given how narrow this corner actually is - a sharp
          // corner needs much more distance than a wide one for the same
          // text width. Capped so a razor-thin angle doesn't push the label
          // implausibly far from its own corner.
          const halfWidth = ctx.measureText(angleLabel).width / 2 + 4;
          const halfAngle = Math.max(interiorAngle / 2, 0.05);
          const inset = Math.min(Math.max(halfWidth / Math.sin(halfAngle), LABEL_MARGIN), MAX_ANGLE_LABEL_INSET);

          placeLabel(angleLabel, point.x, point.y, bx, by, inset, MAX_ANGLE_LABEL_INSET);
        });

        // Label edges with a stated length (e.g. "10 cm"), starting at the
        // edge's midpoint and pushed outward along its perpendicular, away
        // from the centroid - same outward logic as vertex labels above.
        // A 2-point shape is just a line, so its "wraparound" edge back to
        // point 0 is the same segment again - only label it once.
        const edgeCount = shape.points.length === 2 ? 1 : shape.points.length;
        for (let i = 0; i < edgeCount; i++) {
          const edgeLabel = shape.edgeLabels?.[i];
          if (!edgeLabel) continue;
          const p1 = shape.points[i];
          const p2 = shape.points[(i + 1) % shape.points.length];
          const edgeKey = [pointKey(p1), pointKey(p2)].sort().join('|');
          if (labeledEdges.has(edgeKey)) continue;
          labeledEdges.add(edgeKey);
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          let nx = -(p2.y - p1.y);
          let ny = p2.x - p1.x;
          const nLen = Math.hypot(nx, ny) || 1;
          nx /= nLen;
          ny /= nLen;
          if ((midX - centroid.x) * nx + (midY - centroid.y) * ny < 0) {
            nx = -nx;
            ny = -ny;
          }
          placeLabel(edgeLabel, midX, midY, nx, ny, LABEL_MARGIN, LABEL_MARGIN + LABEL_SEARCH_RANGE);
        }
      }
    });
  }, [shapes]);

  useEffect(() => {
    drawShapes();
  }, [drawShapes]);

  // Processes one queued command at a time, independent of whether the mic
  // is still listening - a pause queues a command without stopping capture,
  // so the next command can be spoken right away instead of re-clicking
  // "Start Listening".
  useEffect(() => {
    const processNext = async () => {
      if (commandQueue.length === 0 || isProcessing) return;

      const currentText = commandQueue[0];
      dequeueCommand();
      setIsProcessing(true);
      setErrorMsg(null);

      try {
        console.log("Processing command:", currentText);
        const shapeContext = shapesToAIContext(shapes, CANVAS_WIDTH);
        const commandResult = await parseCommand(currentText, shapeContext, namedPoints);

        if (commandResult && commandResult.shapes) {
          const canvas = canvasRef.current;
          if (canvas) {
            const newShapes = generateShapesFromAI(commandResult, canvas.width);
            setShapes(prevShapes => [...prevShapes, ...newShapes]);
          }
        }
      } catch (err: any) {
        console.error("Error in processCommand:", err);
        if (err.message?.includes("429")) {
          setErrorMsg("Claude API Rate Limit Exceeded. Please wait 30-60 seconds before trying again.");
        } else {
          setErrorMsg("An error occurred while communicating with the AI.");
        }
      } finally {
        setIsProcessing(false);
      }
    };
    processNext();
  }, [commandQueue, isProcessing]);

  // Clear error after 10 seconds
  useEffect(() => {
    if (errorMsg) {
      const timer = setTimeout(() => setErrorMsg(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [errorMsg]);

  const handleClear = () => {
    setShapes([]);
  };

  const handleUndo = () => {
    setShapes(prevShapes => prevShapes.slice(0, -1));
  };

  const statusClass = errorMsg ? 'error' : isListening ? 'recording' : isProcessing ? 'processing' : '';

  return (
    <div className="App">
      <header className="app-header">
        <h1>The Intelligent Whiteboard</h1>
        <p className="subtitle">Speak a command and watch it appear on the board</p>
      </header>

      <div className="controls">
        <button className="btn btn-primary" onClick={startListening} disabled={isListening}>
          <MicIcon className="icon" /> Start Listening
        </button>
        <button className="btn btn-stop" onClick={stopListening} disabled={!isListening}>
          <StopIcon className="icon" /> Stop Listening
        </button>
        <button className="btn btn-ghost" onClick={handleClear} disabled={shapes.length === 0}>
          <TrashIcon className="icon" /> Clear
        </button>
        <button className="btn btn-ghost" onClick={handleUndo} disabled={shapes.length === 0}>
          <UndoIcon className="icon" /> Undo
        </button>
      </div>

      <div className={`status ${statusClass}`}>
        {errorMsg ? (
          <>
            <AlertIcon className="icon" /> {errorMsg}
          </>
        ) : isListening ? (
          <>
            <span className="dot" /> Recording...
            {isProcessing && <span className="spinner" />}
            {commandQueue.length > 0 && <span className="queue-count">+{commandQueue.length}</span>}
          </>
        ) : isProcessing ? (
          <>
            <span className="spinner" /> AI is drawing...
          </>
        ) : (
          <span>Ready</span>
        )}
      </div>

      {Object.keys(namedPoints).length > 0 && (
        <div className="named-points">
          {Object.keys(namedPoints).map(name => (
            <span className="point-chip" key={name}>{name}</span>
          ))}
        </div>
      )}

      <div className={`canvas-card ${isProcessing ? 'is-busy' : ''}`}>
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="whiteboard"
        ></canvas>
      </div>

      <div className="transcript">
        <p className="transcript-label">Transcribed Text</p>
        <p className={`transcript-text ${text ? '' : 'placeholder'}`}>
          {text || 'Say something to draw…'}
        </p>
      </div>
    </div>
  );
}

export default App;