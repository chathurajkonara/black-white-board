import React, { useRef, useLayoutEffect, useEffect, useState } from 'react';
import './App.css';
import useVoiceRecognition from './hooks/useVoiceRecognition';
import { parseCommand, hasApiKey, MissingApiKeyError } from './services/nlpService';
import { generateShapesFromAI, shapesToAIContext, computeContentBounds } from './services/geometryService';
import type { Shape } from './services/geometryService';
import type { Point } from './services/nlpService';
import { MicIcon, StopIcon, TrashIcon, UndoIcon, AlertIcon, ZoomInIcon, ZoomOutIcon, SettingsIcon } from './components/Icons';
import SettingsModal from './components/SettingsModal';
import { findClearLabelSpot } from './services/labelPlacement';
import type { Segment, Arc, LabelBox } from './services/labelPlacement';
import { CANVAS_WIDTH, CANVAS_HEIGHT, AI_WIDTH, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, PAN_STEP } from './constants';

// Recognizes a small, fixed set of zoom phrases locally so they're handled
// instantly, for free, without a round trip to the AI - the drawing model's
// schema only ever describes shapes, so it has no way to express "zoom"
// even if asked. Checked before a spoken command is sent off to parseCommand;
// anything that doesn't match falls through to the AI as a normal drawing
// command, same as today.
const matchZoomCommand = (text: string): 'in' | 'out' | 'reset' | null => {
  const normalized = text.trim().toLowerCase();
  if (/\bzoom\s*in\b/.test(normalized)) return 'in';
  if (/\bzoom\s*out\b/.test(normalized)) return 'out';
  if (/\b(reset\s*(the\s*)?zoom|zoom\s*(to\s*)?100\s*%?|actual\s*size)\b/.test(normalized)) return 'reset';
  return null;
};

// Same idea as matchZoomCommand - a small fixed set of pan phrases, checked
// locally before anything is sent to the AI. "scroll"/"pan" are both
// accepted since either reads naturally ("scroll left", "pan left").
const matchScrollCommand = (text: string): 'up' | 'down' | 'left' | 'right' | null => {
  const normalized = text.trim().toLowerCase();
  if (!/\b(scroll|pan)\b/.test(normalized)) return null;
  if (/\bup\b/.test(normalized)) return 'up';
  if (/\bdown\b/.test(normalized)) return 'down';
  if (/\bleft\b/.test(normalized)) return 'left';
  if (/\bright\b/.test(normalized)) return 'right';
  return null;
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { text, commandQueue, isListening, startListening, stopListening, dequeueCommand } = useVoiceRecognition();
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [keyPresent, setKeyPresent] = useState(() => hasApiKey());
  // Mirrors the viewport's own scroll metrics so the custom scrollbar below
  // can render a thumb without relying on the browser's native scrollbar,
  // which some platforms (notably macOS) keep invisible until the user is
  // actively scrolling - giving no visual cue that a zoomed-in sketch
  // extends past the canvas at all.
  const [scrollMetrics, setScrollMetrics] = useState({
    scrollLeft: 0, scrollTop: 0,
    scrollWidth: CANVAS_WIDTH, scrollHeight: CANVAS_HEIGHT,
    clientWidth: CANVAS_WIDTH, clientHeight: CANVAS_HEIGHT,
  });

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

  // The "page" a sketch actually occupies - normally just the nominal
  // CANVAS_WIDTH x CANVAS_HEIGHT box, but auto-extended to cover any shape
  // that's drifted or poked past it (see computeContentBounds), so there's
  // always somewhere for the canvas buffer/scrollbar to reach it rather
  // than silently clipping it.
  const contentBounds = React.useMemo(
    () => computeContentBounds(shapes, CANVAS_WIDTH, CANVAS_HEIGHT),
    [shapes]
  );
  const pageWidth = contentBounds.maxX - contentBounds.minX;
  const pageHeight = contentBounds.maxY - contentBounds.minY;
  const pageCenterX = (contentBounds.minX + contentBounds.maxX) / 2;
  const pageCenterY = (contentBounds.minY + contentBounds.maxY) / 2;

  // The viewport's own real pixel box - driven purely by CSS (vw/vh, see
  // .canvas-viewport), independent of the canvas's own size, so there's no
  // circularity in using it to size the canvas. Reuses the scrollMetrics
  // measurement already kept in sync (scroll/resize/zoom listeners below)
  // rather than tracking a second copy of the same live DOM read.
  const viewportWidth = scrollMetrics.clientWidth;
  const viewportHeight = scrollMetrics.clientHeight;

  // "Fit to viewport" baseline, like an image viewer's Fit-to-Window: the
  // largest scale at which the whole page still fits inside the viewport's
  // real box without being cropped in either dimension - so a sketch fills
  // more of a large window and shrinks to stay fully visible on a small
  // one, with no scrolling needed at this baseline. Clamped to a sane
  // range as a guard against a degenerate viewport measurement.
  const rawAutoFitScale = Math.min(viewportWidth / pageWidth, viewportHeight / pageHeight);
  const autoFitScale = Math.min(Math.max(rawAutoFitScale, 0.25), 3);

  // The manual zoom buttons/voice commands (zoom state, ZOOM_MIN..ZOOM_MAX)
  // now adjust FURTHER from this auto-fit baseline rather than from the
  // page's raw pixel size - effectiveZoom is what's actually applied to
  // the drawing.
  const effectiveZoom = autoFitScale * zoom;
  // The buffer only grows past the auto-fit baseline when zooming IN
  // further than it; zooming OUT never shrinks the buffer below the
  // baseline itself - the same "canvas doesn't shrink on zoom-out"
  // principle as before, now anchored to the auto-fit view instead of the
  // page's raw pixel size.
  const bufferZoom = autoFitScale * Math.max(zoom, 1);
  const bufferWidth = pageWidth * bufferZoom;
  const bufferHeight = pageHeight * bufferZoom;

  const drawShapes = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // Scale around the page's own center (pageCenterX/Y) rather than the
    // buffer's top-left corner, using effectiveZoom (auto-fit baseline x
    // manual zoom) rather than the raw zoom state. With no overflow and
    // autoFitScale=1 this is exactly the same as scaling from the canvas's
    // geometric center; it's what makes zoom-out shrink shapes toward the
    // middle instead of one corner, and it falls out of the SAME formula
    // for zoom-in's origin-anchored growth (verified by hand: pixel =
    // bufferCenter + effectiveZoom*(P - pageCenter), which reduces to a
    // plain scale from the origin whenever pageCenter sits at
    // bufferWidth/(2*effectiveZoom), bufferHeight/(2*effectiveZoom) - true
    // whenever the buffer is grown exactly in step with effectiveZoom). No
    // separate zoom<1/zoom>=1 branches needed.
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(effectiveZoom, effectiveZoom);
    ctx.translate(-pageCenterX, -pageCenterY);

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

    ctx.restore();
  }, [shapes, effectiveZoom, pageCenterX, pageCenterY]);

  useLayoutEffect(() => {
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

      const zoomAction = matchZoomCommand(currentText);
      if (zoomAction) {
        console.log("Local zoom command:", zoomAction, currentText);
        if (zoomAction === 'in') handleZoomIn();
        else if (zoomAction === 'out') handleZoomOut();
        else handleZoomReset();
        return;
      }

      const scrollAction = matchScrollCommand(currentText);
      if (scrollAction) {
        console.log("Local scroll command:", scrollAction, currentText);
        handleScroll(scrollAction);
        return;
      }

      setIsProcessing(true);
      setErrorMsg(null);

      try {
        console.log("Processing command:", currentText);
        const shapeContext = shapesToAIContext(shapes, CANVAS_WIDTH);
        const commandResult = await parseCommand(currentText, shapeContext, namedPoints);

        if (commandResult && commandResult.shapes) {
          const canvas = canvasRef.current;
          if (canvas) {
            const newShapes = generateShapesFromAI(commandResult, CANVAS_WIDTH);
            setShapes(prevShapes => [...prevShapes, ...newShapes]);
          }
        }
      } catch (err: any) {
        console.error("Error in processCommand:", err);
        if (err instanceof MissingApiKeyError) {
          setErrorMsg("No Anthropic API key set. Click Settings above to add your own key.");
        } else if (err.message?.includes("429")) {
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

  const measureScroll = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    setScrollMetrics({
      scrollLeft: vp.scrollLeft, scrollTop: vp.scrollTop,
      scrollWidth: vp.scrollWidth, scrollHeight: vp.scrollHeight,
      clientWidth: vp.clientWidth, clientHeight: vp.clientHeight,
    });
  };

  // Keeps the custom scrollbar thumb in sync with the viewport's real
  // scroll position, however it was scrolled - wheel, trackpad, keyboard,
  // our own handleScroll, or dragging the thumb itself (which sets
  // viewport.scrollLeft/Top directly, firing this same 'scroll' event).
  // Also re-measures on a window resize, since the viewport's own box size
  // is now responsive (CSS fit-content capped by vw/vh) rather than fixed -
  // its clientWidth/clientHeight can change without zoom or scroll
  // changing at all.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.addEventListener('scroll', measureScroll);
    window.addEventListener('resize', measureScroll);
    return () => {
      vp.removeEventListener('scroll', measureScroll);
      window.removeEventListener('resize', measureScroll);
    };
  }, []);

  // Re-measure whenever the canvas's actual rendered size changes (and so
  // the viewport's scrollWidth/scrollHeight) - after layout has settled.
  // Keyed on bufferWidth/bufferHeight rather than zoom directly, since the
  // buffer can also change size from autoFitScale settling (e.g. right
  // after mount, before the real viewport box has been measured even
  // once) or from the sketch's own content bounds growing - not just from
  // a manual zoom change. This does feed back into scrollMetrics, which
  // autoFitScale itself reads (via viewportWidth/viewportHeight) - but
  // those only come from clientWidth/clientHeight, which this effect
  // doesn't change (only scrollWidth/scrollHeight do), so it settles
  // within a couple of render passes rather than looping.
  useLayoutEffect(() => {
    measureScroll();
  }, [bufferWidth, bufferHeight]);

  const handleClear = () => {
    setShapes([]);
  };

  const handleUndo = () => {
    setShapes(prevShapes => prevShapes.slice(0, -1));
  };

  const handleZoomIn = () => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  const handleZoomOut = () => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP));
  const handleZoomReset = () => setZoom(1);

  const handleScroll = (direction: 'up' | 'down' | 'left' | 'right') => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const dx = direction === 'left' ? -PAN_STEP : direction === 'right' ? PAN_STEP : 0;
    const dy = direction === 'up' ? -PAN_STEP : direction === 'down' ? PAN_STEP : 0;
    viewport.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
  };

  // Dragging the custom scrollbar thumb - converts a pointer-movement delta
  // into a scroll delta via the same ratio a native scrollbar thumb moves
  // at (track size / content size), then sets scrollLeft/scrollTop directly
  // (which fires the native 'scroll' event, so measureScroll picks it up
  // and the thumb's rendered position updates to match).
  const handleThumbDrag = (axis: 'x' | 'y') => (e: React.PointerEvent) => {
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startScroll = axis === 'x' ? vp.scrollLeft : vp.scrollTop;
    const trackSize = axis === 'x' ? vp.clientWidth : vp.clientHeight;
    const scrollSize = axis === 'x' ? vp.scrollWidth : vp.scrollHeight;

    const onMove = (moveEvent: PointerEvent) => {
      const currentPos = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      const scrollDelta = (currentPos - startPos) * (scrollSize / trackSize);
      if (axis === 'x') vp.scrollLeft = startScroll + scrollDelta;
      else vp.scrollTop = startScroll + scrollDelta;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const statusClass = errorMsg ? 'error' : isListening ? 'recording' : isProcessing ? 'processing' : '';
  const hScrollable = scrollMetrics.scrollWidth > scrollMetrics.clientWidth;
  const vScrollable = scrollMetrics.scrollHeight > scrollMetrics.clientHeight;
  const hThumbWidthPct = (scrollMetrics.clientWidth / scrollMetrics.scrollWidth) * 100;
  const hThumbLeftPct = (scrollMetrics.scrollLeft / scrollMetrics.scrollWidth) * 100;
  const vThumbHeightPct = (scrollMetrics.clientHeight / scrollMetrics.scrollHeight) * 100;
  const vThumbTopPct = (scrollMetrics.scrollTop / scrollMetrics.scrollHeight) * 100;

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
        <button className="btn btn-ghost" onClick={handleZoomOut} disabled={zoom <= ZOOM_MIN}>
          <ZoomOutIcon className="icon" /> Zoom Out
        </button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button className="btn btn-ghost" onClick={handleZoomIn} disabled={zoom >= ZOOM_MAX}>
          <ZoomInIcon className="icon" /> Zoom In
        </button>
        <button className="btn btn-ghost" onClick={handleZoomReset} disabled={zoom === 1}>
          Reset Zoom
        </button>
        <button className="btn btn-ghost" onClick={() => setIsSettingsOpen(true)}>
          <SettingsIcon className="icon" /> Settings
          <span className={`key-dot ${keyPresent ? 'key-dot-set' : 'key-dot-unset'}`} />
        </button>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onKeyChange={() => setKeyPresent(hasApiKey())}
      />

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
        <div className="canvas-scroll-wrap">
          <div className="canvas-viewport" ref={viewportRef}>
            <canvas
              ref={canvasRef}
              width={bufferWidth}
              height={bufferHeight}
              className="whiteboard"
            ></canvas>
          </div>
          {hScrollable && (
            <div className="custom-scrollbar-track horizontal">
              <div
                className="custom-scrollbar-thumb"
                style={{ width: `${hThumbWidthPct}%`, left: `${hThumbLeftPct}%` }}
                onPointerDown={handleThumbDrag('x')}
              />
            </div>
          )}
          {vScrollable && (
            <div className="custom-scrollbar-track vertical">
              <div
                className="custom-scrollbar-thumb"
                style={{ height: `${vThumbHeightPct}%`, top: `${vThumbTopPct}%` }}
                onPointerDown={handleThumbDrag('y')}
              />
            </div>
          )}
        </div>
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