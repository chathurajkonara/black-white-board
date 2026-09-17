import React, { useRef, useEffect, useState } from 'react';
import './App.css';
import useVoiceRecognition from './hooks/useVoiceRecognition';
import { parseCommand } from './services/nlpService';
import { generateShapesFromAI } from './services/geometryService';
import type { Shape } from './services/geometryService';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { text, isListening, startListening, stopListening, setText } = useVoiceRecognition();
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const drawShapes = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;

    shapes.forEach(shape => {
      ctx.strokeStyle = shape.color || 'black';
      
      if (shape.type === 'circle' && shape.radius) {
        ctx.beginPath();
        const center = shape.points[0];
        ctx.arc(center.x, center.y, shape.radius, 0, Math.PI * 2);
        ctx.stroke();
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
      }
    });
  }, [shapes]);

  useEffect(() => {
    drawShapes();
  }, [drawShapes]);

  useEffect(() => {
    const processCommand = async () => {
      if (!isListening && text && !isProcessing) {
        const currentText = text;
        setText('');
        setIsProcessing(true);
        setErrorMsg(null);
        
        try {
          console.log("Processing final transcript:", currentText);
          const commandResult = await parseCommand(currentText, shapes);
          
          if (commandResult && commandResult.shapes) {
            const canvas = canvasRef.current;
            if (canvas) {
              const newShapes = generateShapesFromAI(commandResult, canvas.width, canvas.height);
              setShapes(prevShapes => [...prevShapes, ...newShapes]);
            }
          }
        } catch (err: any) {
          console.error("Error in processCommand:", err);
          if (err.message?.includes("429")) {
            setErrorMsg("Gemini API Rate Limit Exceeded. Please wait 30-60 seconds before trying again.");
          } else {
            setErrorMsg("An error occurred while communicating with the AI.");
          }
        } finally {
          setIsProcessing(false);
        }
      }
    };
    processCommand();
  }, [isListening, text, isProcessing, setText]);

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

  return (
    <div className="App">
      <h1>The Intelligent White Board</h1>
      <div className="controls">
        <button onClick={startListening} disabled={isListening || isProcessing}>
          Start Listening
        </button>
        <button onClick={stopListening} disabled={!isListening}>
          Stop Listening
        </button>
        <button onClick={handleClear}>Clear</button>
        <button onClick={handleUndo}>Undo</button>
      </div>
      <div className="status">
        {errorMsg ? <span className="error-msg">{errorMsg}</span> :
         isListening ? <span className="recording">● Recording...</span> : 
         isProcessing ? <span className="processing">⚙ AI is drawing...</span> : 
         <span>Ready</span>}
      </div>
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        className="whiteboard"
      ></canvas>
      <div>
        <p>Transcribed Text:</p>
        <p><i>{text || '...'}</i></p>
      </div>
    </div>
  );
}

export default App;