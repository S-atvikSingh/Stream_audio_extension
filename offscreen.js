let websocket = null;
let audioContext = null;
let processor = null;

// offscreen.js - Replace the listener with this version
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.target !== 'offscreen-doc') return;

  if (msg.type === 'INITIALIZE_AUDIO') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab', 
            chromeMediaSourceId: msg.streamId
          }
        },
        video: false
      });

      websocket = new WebSocket(msg.serverUrl);
      
      websocket.onopen = () => {
        // Send hardware sample rate to the server
        websocket.send(JSON.stringify({
          type: "metadata",
          sampleRate: audioContext.sampleRate
        }));
      };

      websocket.onmessage = (e) => {
        chrome.runtime.sendMessage({ type: 'UI_UPDATE', payload: JSON.parse(e.data) }).catch(() => {});
      };

      // Native hardware rate for perfect playback quality
      audioContext = new AudioContext(); 
      const source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(16384, 1, 1);

      // Audio Playback remains high-quality and unchanged
      source.connect(audioContext.destination);
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      processor.onaudioprocess = (e) => {
        if (websocket?.readyState === WebSocket.OPEN) {
          // Get raw Float32 data (32-bit floats)
          const input = e.inputBuffer.getChannelData(0);
          
          // Send raw float buffer as base64
          websocket.send(JSON.stringify({
            type: 'audio',
            data: btoa(String.fromCharCode(...new Uint8Array(input.buffer)))
          }));
        }
      };

    } catch (err) {
      console.error("Offscreen capture failed:", err);
    }
  }

  if (msg.type === 'STOP_AUDIO') {
    if (processor) processor.disconnect();
    if (audioContext) audioContext.close();
    if (websocket) websocket.close();
    chrome.offscreen.closeDocument();
  }
});