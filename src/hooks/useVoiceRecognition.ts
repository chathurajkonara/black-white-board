import { useState, useEffect, useRef } from 'react';

// How long to wait after the last recognized word before treating the user
// as done with that command and queuing it for processing.
const SILENCE_TIMEOUT_MS = 1800;

const useVoiceRecognition = () => {
  const [text, setText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [commandQueue, setCommandQueue] = useState<string[]>([]);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `isListening` for use inside the recognition's own callbacks.
  // Those callbacks are defined once when the recognition object is built
  // and close over whatever `isListening` was AT THAT TIME - a plain state
  // read there goes stale forever. A ref always reflects the current value
  // when read, regardless of when the closure was created.
  const isListeningRef = useRef(false);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!('webkitSpeechRecognition' in window)) {
      console.error("Web Speech API is not supported by this browser.");
      return;
    }

    const recognition = new (window as any).webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      const utterance = finalTranscript + interimTranscript;
      setText(utterance);

      // Every new word restarts the pause timer. If nothing new comes in
      // before it fires, the user is done with this command - queue it and
      // reset the transcript for the next one, but keep the mic listening.
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => {
        if (utterance.trim()) {
          setCommandQueue(q => [...q, utterance]);
        }
        setText('');
      }, SILENCE_TIMEOUT_MS);
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      clearSilenceTimer();
    };

    recognition.onend = () => {
      clearSilenceTimer();
      // continuous=true should keep this running indefinitely, but some
      // browsers end the session on their own (e.g. after a period of
      // silence) - restart automatically unless the user explicitly
      // stopped it. Reads the ref (always current), not `isListening`
      // (frozen at whatever it was when this closure was created).
      if (isListeningRef.current) {
        // A short delay avoids a rare InvalidStateError some browsers throw
        // when start() is called synchronously from inside onend, before
        // their internal state has fully reset.
        setTimeout(() => {
          if (!isListeningRef.current) return; // user stopped during the delay
          try {
            recognition.start();
          } catch (e) {
            console.error('Failed to restart speech recognition', e);
          }
        }, 100);
      }
    };

    recognitionRef.current = recognition;
    // Built exactly once - restart logic above relies on isListeningRef,
    // not on recreating this object, so there's no need to depend on
    // `isListening` here (that was the source of the stale-closure bug).
  }, []);

  const startListening = () => {
    if (recognitionRef.current && !isListening) {
      isListeningRef.current = true;
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopListening = () => {
    clearSilenceTimer();
    if (recognitionRef.current && isListening) {
      isListeningRef.current = false;
      recognitionRef.current.stop();
      setIsListening(false);
      // Treat stopping mid-utterance the same as a natural pause - whatever
      // was said still gets queued instead of silently discarded.
      if (text.trim()) {
        setCommandQueue(q => [...q, text]);
      }
      setText('');
    }
  };

  const dequeueCommand = () => {
    setCommandQueue(q => q.slice(1));
  };

  return { text, commandQueue, isListening, startListening, stopListening, dequeueCommand };
};

export default useVoiceRecognition;
