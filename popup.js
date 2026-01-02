/**
 * popup.js - Window Mode Controller
 * This script runs in the dedicated popup window and manages the UI state.
 */

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const serverUrlInput = document.getElementById('serverUrl');
const statusText = document.getElementById('statusText');
const transcriptionContainer = document.getElementById('transcriptionContainer');
const llmContainer = document.getElementById('llmContainer');

// --- Initialization ---

// Optional: Load the last used server URL from storage
chrome.storage.local.get(['lastServerUrl'], (result) => {
  if (result.lastServerUrl) {
    serverUrlInput.value = result.lastServerUrl;
  }
});

// --- Event Handlers ---

startBtn.onclick = () => {
  const serverUrl = serverUrlInput.value.trim();
  
  if (!serverUrl) {
    alert("Please enter a valid WebSocket server URL.");
    return;
  }

  // Save URL for convenience next time
  chrome.storage.local.set({ lastServerUrl: serverUrl });

  // Update UI State
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusText.textContent = "Status: Connecting to tab audio...";
  statusText.style.color = "#f39c12";

  // Trigger the background script to start the Tab Capture flow
  chrome.runtime.sendMessage({
    type: 'START_TRANSCRIPTION',
    serverUrl: serverUrl
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Communication Error:", chrome.runtime.lastError);
      resetUI("Error: Could not reach background.");
      return;
    }
    console.log("Transcription process initiated:", response);
  });
};

stopBtn.onclick = () => {
  // Tell the offscreen document to kill the stream and socket
  chrome.runtime.sendMessage({
    target: 'offscreen-doc',
    type: 'STOP_AUDIO'
  });

  resetUI("Status: Stopped");
};

// --- Message Listener ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UI_UPDATE') {
    const data = msg.payload;
    
    // 1. Handle Transcription (Always display)
    if (data.type === 'transcription') {
      const container = document.getElementById('transcriptionContainer');
      if (container) {
        if (container.querySelector('.no-transcription')) container.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'transcription-entry';
        div.innerHTML = `<div class="transcription-text">${data.text}</div>`;
        container.prepend(div);
      }
    } 

    // 2. Handle LLM Context (Filter out empty/useless values)
    else if (data.type === 'context_partial') {
      const llmContainer = document.getElementById('llmContainer');
      const textValue = data.json?.context || data.text || "";

      // Only update if the text is actually meaningful
      // You can add more specific "empty" strings to the array below
      const uselessValues = ["", "none", "No relevant context extracted", "undefined", "null", "ChatCompletion(id=","audio_tokens=0"];
      
      if (textValue && !uselessValues.includes(textValue.trim())) {
        if (llmContainer) {
          if (llmContainer.querySelector('.no-transcription')) llmContainer.innerHTML = '';
          llmContainer.innerHTML = `<div class="transcription-text">${textValue.replace(/\n/g, '<br>')}</div>`;
        }
      }
    }
  }
});

// --- Helper Functions ---

function updateStatus(text, color) {
  statusText.textContent = text;
  statusText.style.color = color;
}

function resetUI(message) {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusText.textContent = message;
  statusText.style.color = "#7f8c8d";
}

function appendTranscription(text) {
  if (!text) return;
  
  // Remove "No transcription" placeholder if it exists
  const placeholder = transcriptionContainer.querySelector('.no-transcription');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = 'transcription-entry';
  div.style.marginBottom = "8px";
  div.style.padding = "5px";
  div.style.borderBottom = "1px solid #eee";
  
  const span = document.createElement('span');
  span.className = 'transcription-text';
  span.textContent = text;
  
  div.appendChild(span);
  
  // Prepend so newest appears at the top
  transcriptionContainer.prepend(div);
}

function updateLLMContext(text) {
  if (!text) return;

  const placeholder = llmContainer.querySelector('.no-transcription');
  if (placeholder) placeholder.remove();

  // For LLM context, we usually want to replace the content with the latest summary
  llmContainer.innerHTML = `<div class="transcription-text">${text.replace(/\n/g, '<br>')}</div>`;
}