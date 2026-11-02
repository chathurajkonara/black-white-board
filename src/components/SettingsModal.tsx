import { useState } from 'react';
import { getApiKey, setApiKey, clearApiKey } from '../services/nlpService';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onKeyChange: () => void;
}

function SettingsModal({ isOpen, onClose, onKeyChange }: SettingsModalProps) {
  const [draft, setDraft] = useState(() => getApiKey() ?? '');
  const [showKey, setShowKey] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    setApiKey(draft);
    onKeyChange();
    onClose();
  };

  const handleClear = () => {
    clearApiKey();
    setDraft('');
    onKeyChange();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <h2>Anthropic API Key</h2>
        <p className="hint">
          Stored only in this browser and sent directly to Anthropic when you use the whiteboard — never sent anywhere else.
        </p>
        <div className="input-row">
          <input
            type={showKey ? 'text' : 'password'}
            className="text-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="sk-ant-..."
          />
          <button type="button" className="btn btn-ghost" onClick={() => setShowKey(s => !s)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={handleClear}>Clear</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={draft.trim() === ''}>Save</button>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
