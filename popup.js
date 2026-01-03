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
const bigConfigSection = document.getElementById('bigConfigSection'); // Wrap your setup text in this ID

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
  // UI Minimization
  if (bigConfigSection) bigConfigSection.style.display = 'none';

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
  // UI Minimization
  if (bigConfigSection) bigConfigSection.style.display = 'block';
  
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

    // 2. Handle LLM Context (Prepend history instead of replacing)
    else if (data.type === 'context_partial') {
      const llmContainer = document.getElementById('llmContainer');
      
      // Robustly extract the textValue from the nested JSON structure
      const textValue = data.json?.context || data.text || "";

      // Filter out "garbage" or empty results
      const uselessValues = ["", "none", "No relevant context extracted", "undefined", "null"];
      
      // Check if textValue starts with the ChatCompletion object string to catch errors
      const isGarbage = uselessValues.includes(textValue.trim()) || textValue.includes("ChatCompletion(id=");

      if (textValue && !isGarbage) {
        if (llmContainer) {
          // 1. Remove "No context" placeholder ONLY if it exists
          const placeholder = llmContainer.querySelector('.no-transcription');
          if (placeholder) {
            llmContainer.innerHTML = ''; 
          }

          // 2. Create a unique wrapper for this specific update
          const entry = document.createElement('div');
          entry.className = 'llm-context-entry';
          entry.style.borderBottom = "1px solid #ddd";
          entry.style.padding = "10px 0";
          entry.style.marginBottom = "10px";

          // 3. Optional: Add a small timestamp to help distinguish entries
          const time = new Date().toLocaleTimeString();
          const timeSpan = `<small style="color: #888; display: block;">${time}</small>`;

          // 4. Set content with line breaks preserved
          entry.innerHTML = `${timeSpan}<div class="transcription-text">${textValue.replace(/\n/g, '<br>')}</div>`;

          // 5. USE PREPEND: This pushes previous entries down instead of deleting them
          llmContainer.prepend(entry);
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
  //llmContainer.innerHTML = `<div class="transcription-text">${text.replace(/\n/g, '<br>')}</div>`;
  // Trying to prepend the context so that previous context are also visible:
  // 3. Create a unique wrapper for THIS specific insight
  const entryDiv = document.createElement('div');
  entryDiv.className = 'llm-context-item';
  
  // Style it so it looks like a distinct card in a feed
  entryDiv.style.borderLeft = "4px solid #007bff";
  entryDiv.style.backgroundColor = "#fcfcfc";
  entryDiv.style.padding = "12px";
  entryDiv.style.marginBottom = "15px";
  entryDiv.style.boxShadow = "0 2px 4px rgba(0,0,0,0.05)";
  entryDiv.style.borderRadius = "4px";

  // 4. Add a timestamp so you can see it's a new entry
  const timeLabel = document.createElement('small');
  timeLabel.style.color = "#888";
  timeLabel.style.display = "block";
  timeLabel.style.marginBottom = "5px";
  timeLabel.textContent = new Date().toLocaleTimeString();

  // 5. Create the content area (using innerHTML for Markdown/Tables)
  const contentDiv = document.createElement('div');
  contentDiv.className = 'context-body';
  // Replace newlines with breaks for readability
  contentDiv.innerHTML = text.replace(/\n/g, '<br>');

  // 6. Assemble and PREPEND
  entryDiv.appendChild(timeLabel);
  entryDiv.appendChild(contentDiv);
  
  // This pushes previous entries down, making them scrollable
  llmContainer.prepend(entryDiv);
}