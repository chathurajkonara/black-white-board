import { GoogleGenerativeAI } from "@google/generative-ai";

export interface Point {
  x: number;
  y: number;
}

export interface AIShape {
  type: 'polygon' | 'circle';
  points?: Point[];
  center?: Point;
  radius?: number;
  color: string;
  label?: string;
}

export interface ParsedCommand {
  shapes: AIShape[];
}

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(API_KEY || "");
// Using gemini-2.5-flash - the newest model on your list, likely has a fresh quota
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const systemPrompt = `
You are a spatial reasoning drawing assistant. 
Translate user commands into a JSON list of geometric shapes (0-1000 coordinate system).
0,0 is top-left, 1000,1000 is bottom-right.

Return ONLY a valid JSON object. No markdown, no explanations.
{
  "shapes": [
    { "type": "polygon", "points": [{"x": 500, "y": 100}, ...], "color": "red", "label": "roof" },
    { "type": "circle", "center": {"x": 800, "y": 200}, "radius": 50, "color": "yellow", "label": "sun" }
  ]
}
`;

export const parseCommand = async (command: string, currentShapes: any[]): Promise<ParsedCommand | null> => {
  if (!API_KEY || !command.trim()) return null;

  try {
    const context = currentShapes.length > 0 
        ? `Current Board State: ${JSON.stringify(currentShapes.map(s => ({ label: s.label, type: s.type, color: s.color })))}`
        : "The board is empty.";

    const prompt = `System: ${systemPrompt}\nContext: ${context}\nUser Command: ${command}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();
    
    // Clean up markdown
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    
    return JSON.parse(text) as ParsedCommand;
  } catch (error: any) {
    // Re-throw to handle in App.tsx UI
    throw error;
  }
};
