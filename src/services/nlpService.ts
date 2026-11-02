import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AI_HEIGHT, API_KEY_STORAGE_KEY } from "../constants";

// The key is entered by each user via the Settings modal and kept only in
// their own browser's localStorage - never baked into the build, so the
// public bundle never embeds anyone's secret.
export const getApiKey = (): string | null => localStorage.getItem(API_KEY_STORAGE_KEY);
export const hasApiKey = (): boolean => !!getApiKey()?.trim();
export const setApiKey = (key: string): void => localStorage.setItem(API_KEY_STORAGE_KEY, key.trim());
export const clearApiKey = (): void => localStorage.removeItem(API_KEY_STORAGE_KEY);

// Thrown by parseCommand when no key is configured yet, so the caller can
// point the user at Settings instead of showing a generic API-error message.
export class MissingApiKeyError extends Error {
  constructor() {
    super("No Anthropic API key configured.");
    this.name = "MissingApiKeyError";
  }
}

const MODEL = "claude-opus-5";

const systemPrompt = `
You are a spatial reasoning drawing assistant.
Translate user commands into a JSON list of geometric shapes (0-1000 coordinate system).
0,0 is top-left. x ranges 0-1000 across the full width; y ranges 0-${AI_HEIGHT} across the
full height, using that SAME per-unit scale as x (not a separate 0-1000 range for y) - so equal
x and y distances really are equal distances. A true square/circle therefore needs equal x and
y extents in this space; do not stretch a shape's y-extent to compensate for the canvas's own
aspect ratio.

The context includes "Current Board State": every shape already drawn, with its exact
geometry in this same coordinate space (points/center, radius, startAngle/endAngle) plus
whatever real-world size it was given (a circle/sector's "sizeLabel", or a polygon's
"edgeLabels" per edge, e.g. a square with edgeLabels ["10 cm","10 cm","10 cm","10 cm"] is 10cm
per side). Use this to keep new shapes geometrically and proportionally consistent with what's
already on the board rather than guessing independently:
- If the new command states a real-world size (e.g. "a circle with 5 cm radius") and some
  existing shape has both known coordinate geometry and a stated real-world size, derive the
  coordinate-units-per-real-unit scale from that existing shape (its coordinate span divided by
  its stated real length) and apply that SAME scale to size the new shape. Example: a square
  has edgeLabels stating "10 cm" sides and its points span 400 coordinate units per side (scale
  40 units/cm); a circle with "5 cm radius" drawn inside it must then get radius 200 units (5 *
  40), not an arbitrary guess - so it actually touches the square's sides as a 5cm circle inside
  a 10cm square should.
- If the new command positions a shape relative to an existing one ("inside", "centered in",
  "touching the edge/base of", "next to", "on top of", etc.), compute the new shape's exact
  coordinates from that existing shape's REAL coordinates (its actual center/centroid, edge
  midpoints, or vertices) rather than estimating a position independently.
- If no existing shape on the board has a stated real-world size to anchor a scale from, fall
  back to your own best consistent spatial judgment, but still never ignore the actual size and
  position of shapes already drawn.

Points may carry an optional "name" (e.g. "A", "B") labeling that vertex/corner so the user
can refer back to it in a later command. Only set "name" on a point when the user explicitly
asks for named corners/points, or when this command reuses a name that already exists.

The context includes "Known Named Points": the exact coordinates of every named point still
on the board. When the user's command references one of those names (e.g. "using A and B as
the base"), you MUST reuse its exact x/y coordinates unchanged - never approximate or shift
them. Construct the rest of the new shape so it is geometrically consistent with those fixed
points (e.g. a square "using A and B as a base" has A and B as one edge, with the other two
corners placed to form right angles and a side length equal to the distance from A to B).

Every shape must carry real computed geometry - a "polygon" always needs its full "points"
array (at least 2 vertices), a "circle" always needs "center" and "radius", and a "sector"
always needs "center", "radius", "startAngle" and "endAngle". Never describe geometry only in
"label" text or omit points/center - if you cannot compute exact coordinates, make your best
geometric estimate rather than leaving them out.

For a pie-slice / wedge / arc of a circle, use type "sector" - never approximate it as a
"polygon" with points sampled along the curve, since straight chords will visibly fail to
match a true circle's curve. "startAngle"/"endAngle" are in degrees, measured clockwise from
the positive x-axis (3 o'clock = 0deg, 6 o'clock = 90deg), with startAngle < endAngle (e.g. the
top-right quarter of a circle is startAngle 270, endAngle 360). If the command references an
existing circle on the board (e.g. "cut that circle into 4 sectors", "shade a quarter of it"),
the sector(s) MUST reuse that circle's exact "center" and "radius" unchanged so their curved
edge lines up exactly with the circle's circumference - never re-estimate them.

A "polygon" may optionally include "edgeLabels": an array the SAME LENGTH as "points", where
edgeLabels[i] is a length label (e.g. "10 cm", "8 m") for the edge running from points[i] to
the next point (points[i+1], wrapping back to points[0] after the last point). Use "" for any
edge with no stated length. Only put a label on an edge when the user gave a real length for
it (e.g. "a base of 10cm", "sides of 5cm, 6cm and 7cm") - never invent or estimate a
measurement that wasn't stated, and keep whatever unit the user used.

A "circle" or "sector" may optionally include "sizeLabel": a short text label for a stated
size, e.g. "circle with diameter 4 cm" -> sizeLabel "d = 4 cm"; "circle with radius 2 cm" ->
sizeLabel "r = 2 cm". Since a bare number would be ambiguous between radius and diameter,
always make the label itself say which one it is. Only set this when the user actually stated
a size - never invent one.

A "polygon" may optionally include "angleLabels": an array the SAME LENGTH as "points", where
angleLabels[i] is a label for the interior angle AT points[i] (e.g. "30°", "90°"). Use "" for
any corner with no stated angle. Only label a corner when the user gave a real angle for it
(e.g. "a 30 degree corner", "a right angle at B", "top corner is 45 degrees") - never invent or
estimate an angle that wasn't stated. When you place a labeled corner, its two adjacent edges
should actually form that angle as closely as the rest of the shape's constraints allow.
`;

const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
  // Optional label for a vertex/corner (e.g. "A") so a later voice command
  // can reference this exact point again (e.g. "use A and B as the base").
  name: z.string().optional(),
});

export type Point = z.infer<typeof PointSchema>;

// Discriminated union so structured outputs *requires* real geometry per
// shape type - a "polygon" cannot validate without a real "points" array,
// a "circle" cannot validate without "center"/"radius". Previously these
// were optional, which let a response satisfy the schema while describing
// the shape only in prose inside "label" and omitting actual coordinates.
const PolygonShapeSchema = z.object({
  type: z.literal("polygon"),
  points: z.array(PointSchema).min(2),
  // Parallel to "points" - edgeLabels[i] labels the edge from points[i] to
  // the next point, "" meaning no label. Kept as plain strings (rather than
  // a nullable/sparse array) so it stays simple for structured outputs.
  edgeLabels: z.array(z.string()).optional(),
  // Parallel to "points" - angleLabels[i] labels the interior angle at
  // points[i], "" meaning no label.
  angleLabels: z.array(z.string()).optional(),
  color: z.string(),
  label: z.string().optional(),
});

const CircleShapeSchema = z.object({
  type: z.literal("circle"),
  center: PointSchema,
  radius: z.number(),
  // A stated real-world size (e.g. "d = 4 cm") - see the system prompt for
  // why the label itself must disambiguate radius vs. diameter.
  sizeLabel: z.string().optional(),
  color: z.string(),
  label: z.string().optional(),
});

const SectorShapeSchema = z.object({
  type: z.literal("sector"),
  center: PointSchema,
  radius: z.number(),
  // Degrees, clockwise from the positive x-axis. See the system prompt for
  // the exact convention - kept in sync with the arc drawn in App.tsx.
  startAngle: z.number(),
  endAngle: z.number(),
  sizeLabel: z.string().optional(),
  color: z.string(),
  label: z.string().optional(),
});

const ShapeSchema = z.discriminatedUnion("type", [PolygonShapeSchema, CircleShapeSchema, SectorShapeSchema]);

export type AIShape = z.infer<typeof ShapeSchema>;

const ParsedCommandSchema = z.object({
  shapes: z.array(ShapeSchema),
});

export type ParsedCommand = z.infer<typeof ParsedCommandSchema>;

// A shape already on the board, handed back as context for the next
// command - full geometry (in the same 0-1000/0-AI_HEIGHT space described in
// the system prompt) plus any stated real-world size, so the model can
// anchor a new shape's scale/position to what's actually there instead of
// guessing. Built by geometryService's `shapesToAIContext` from the pixel-
// space shapes on the board.
export interface ExistingShapeContext {
  type: string;
  label?: string;
  color: string;
  points: Point[];
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  sizeLabel?: string;
  edgeLabels?: string[];
  angleLabels?: string[];
}

export const parseCommand = async (
  command: string,
  currentShapes: ExistingShapeContext[],
  namedPoints: Record<string, Point> = {},
): Promise<ParsedCommand | null> => {
  if (!command.trim()) return null;

  const apiKey = getApiKey();
  if (!apiKey) throw new MissingApiKeyError();

  const client = new Anthropic({
    apiKey,
    // This app calls the Anthropic API directly from the browser - there's
    // no backend. Each user supplies their own key via Settings, so it's
    // their own key exposed to their own client, not a shared secret.
    dangerouslyAllowBrowser: true,
  });

  const context = currentShapes.length > 0
      ? `Current Board State: ${JSON.stringify(currentShapes)}`
      : "The board is empty.";

  const namedPointsContext = Object.keys(namedPoints).length > 0
      ? `Known Named Points (0-1000 coordinate space): ${JSON.stringify(namedPoints)}`
      : "No named points yet.";

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    // Every request's `messages` turn is unique (transcript, board state,
    // named points), so a cache breakpoint there would never be read back -
    // it would just add the write premium to every request for nothing.
    // The system prompt, by contrast, is byte-identical every time, so the
    // breakpoint goes here instead, letting repeated calls skip reprocessing
    // it (check response.usage.cache_read_input_tokens to confirm hits).
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      // Reusing named points geometrically (e.g. building a square off an
      // existing base edge) needs more careful reasoning than a plain
      // "draw a shape" - worth the extra latency over the previous "low".
      effort: "medium",
      format: zodOutputFormat(ParsedCommandSchema),
    },
    messages: [
      { role: "user", content: `Context: ${context}\n${namedPointsContext}\nUser Command: ${command}` },
    ],
  });

  // Prompt caching has no server-side dashboard for this app - this is the
  // only way to confirm it's actually working. A cold first call shows
  // cache_creation_input_tokens > 0; every call after that (within the
  // 5-minute TTL) should show cache_read_input_tokens > 0 instead.
  console.log("Cache usage:", {
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens,
    input_tokens: response.usage.input_tokens,
  });

  if (!response.parsed_output) {
    throw new Error("Claude returned a response that did not match the expected shape schema.");
  }

  return response.parsed_output;
};
