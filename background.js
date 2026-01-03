chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 450,
    height: 700
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
  // 1. Check if offscreen doc is already open
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const offscreenExists = contexts.length > 0;

  // 2. If it exists, we don't need a new streamId; just tell it to RE-INITIALIZE
  if (offscreenExists) {
    chrome.runtime.sendMessage({
      target: 'offscreen-doc',
      type: 'INITIALIZE_AUDIO',
      serverUrl: serverUrl
      // streamId is omitted because offscreen.js already has currentStream
    });
    return;
  }

  // 3. If it doesn't exist, do the full first-time setup
  // Prioritize the active tab in the current window if it is audible
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const audibleTabs = await chrome.tabs.query({ audible: true });
  
  const targetTab = (activeTab && activeTab.audible) ? activeTab : (audibleTabs[0] || activeTab);
  
  if (!targetTab) {
    console.error("No active or audible tab found.");
    return;
  }
  //const tabs = await chrome.tabs.query({ audible: true });
  //const targetTab = tabs.length > 0 ? tabs[0] : (await chrome.tabs.query({ currentWindow: false, active: true }))[0];

  if (!targetTab) return;

  await setupOffscreen();

  chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, (streamId) => {
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