chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 450,
    height: 600
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_TRANSCRIPTION') {
    handleStart(msg.serverUrl);
    sendResponse({ status: 'initiated' });
  }
  return true;
});

async function handleStart(serverUrl) {
  // 1. Find the tab that is actually playing audio (the lecture/video)
  // We exclude the popup window by checking for tabs in other windows
  const tabs = await chrome.tabs.query({ audible: true });
  const targetTab = tabs.length > 0 ? tabs[0] : (await chrome.tabs.query({ currentWindow: false, active: true }))[0];

  if (!targetTab) {
    console.error("No target tab found to capture.");
    return;
  }

  // 2. Setup Offscreen
  await setupOffscreen();

  // 3. Capture the stream ID for that specific Tab
  // This avoids the 'activeTab' requirement because we have 'tabs' permission
  chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, (streamId) => {
    if (chrome.runtime.lastError) {
      console.error("Capture Error:", chrome.runtime.lastError.message);
      return;
    }

    // 4. Send to Offscreen
    chrome.runtime.sendMessage({
      target: 'offscreen-doc',
      type: 'INITIALIZE_AUDIO',
      streamId: streamId,
      serverUrl: serverUrl
    });
  });
}

async function setupOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Process tab audio'
  });
}