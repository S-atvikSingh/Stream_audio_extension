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
let audioDataBuffer = new Array(50).fill(0);
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

document.getElementById('exportBtn').onclick = () => {
  const transcriptHTML = transcriptionContainer.innerHTML;
  const contextHTML = llmContainer.innerHTML;

  // Create a full HTML document string for better readability and clickable links
  const fullHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Session Export - ${new Date().toLocaleString()}</title>
      <style>
        body { font-family: sans-serif; line-height: 1.6; padding: 20px; color: #333; }
        h1 { border-bottom: 2px solid #007bff; color: #007bff; }
        .section { margin-bottom: 30px; border: 1px solid #eee; padding: 15px; border-radius: 8px; }
        .entry { margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #fafafa; }
        .timestamp { color: #888; font-size: 0.8em; }
        pre { background: #f4f4f4; padding: 10px; overflow-x: auto; }
      </style>
    </head>
    <body>
      <h1>Session Enhancement Report</h1>
      <div class="section">
        <h2>AI Context & Blueprints</h2>
        ${contextHTML}
      </div>
      <div class="section">
        <h2>Transcripts</h2>
        ${transcriptHTML}
      </div>
    </body>
    </html>
  `;

  const blob = new Blob([fullHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `session_report_${new Date().getTime()}.html`;
  a.click();
  URL.revokeObjectURL(url);
};
// --- Message Listener ---

// --- Integrated Message Listener with Chronological Append & Auto-Scroll ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UI_UPDATE') {
    const data = msg.payload;
    const isAutoScrollEnabled = document.getElementById('autoScrollToggle').checked;
    
    // 1. Handle Transcription (Append to Bottom)
    if (data.type === 'transcription') {
      const container = document.getElementById('transcriptionContainer');
      if (container) {
        if (container.querySelector('.no-transcription')) container.innerHTML = '';
        
        const div = document.createElement('div');
        div.className = 'transcription-entry';
        div.style.borderTop = "1px solid #eee";
        div.style.padding = "5px 0";
        div.innerHTML = `<div class="transcription-text">${data.text}</div>`;
        
        // Append ensures the Export file reads from Start to End
        container.append(div);
        
        if (isAutoScrollEnabled) {
          div.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    } 

    // 2. Handle LLM Context (Append to Bottom)
    else if (data.type === 'context_partial') {
      const llmContainer = document.getElementById('llmContainer');
      const textValue = data.json?.context || data.text || "";
      // DEFENSIVE PARSING: If the LLM sent a string that is actually ANOTHER JSON object
      try {
          const nested = JSON.parse(textValue);
          if (nested.context) textValue = nested.context;
      } catch (e) {
          // It's just a normal string, proceed
      }

      const uselessValues = ["", "none", "No relevant context extracted", "undefined", "null"];
      const isGarbage = uselessValues.includes(textValue.trim()) || textValue.includes("ChatCompletion(id=");

      if (textValue && !isGarbage) {
        if (llmContainer) {
          const placeholder = llmContainer.querySelector('.no-transcription');
          if (placeholder) llmContainer.innerHTML = ''; 

          const entry = document.createElement('div');
          entry.className = 'llm-context-entry';
          entry.style.borderTop = "2px solid #007bff"; // Visual break for new blocks
          entry.style.padding = "10px 0";
          entry.style.marginTop = "15px";
          entry.style.marginBottom = "10px";

          // Convert Markdown links to HTML <a> tags
          const formattedText = textValue
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
            .replace(/\n/g, '<br>');

          const time = new Date().toLocaleTimeString();
          entry.innerHTML = `
            <small style="color: #007bff; font-weight: bold;">[AI INSIGHT - ${time}]</small>
            <div class="transcription-text" style="margin-top: 5px;">${formattedText}</div>
          `;

          // Append to keep the chronological flow for Export
          llmContainer.append(entry);

          if (isAutoScrollEnabled) {
            entry.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
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