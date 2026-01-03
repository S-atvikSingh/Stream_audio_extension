let websocket = null;
let audioContext = null;
let processor = null;
let source = null;
let currentStream = null;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.target !== 'offscreen-doc') return;

  if (msg.type === 'INITIALIZE_AUDIO') {
    try {
      // 1. Singleton Initialization: Only create the AudioContext and Stream ONCE
      if (!audioContext) {
        currentStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: msg.streamId
            }
          },
          video: false
        });

        audioContext = new AudioContext();
        source = audioContext.createMediaStreamSource(currentStream);
        processor = audioContext.createScriptProcessor(16384, 1, 1);

        // This connection is permanent so user never loses audio
        source.connect(audioContext.destination);
      }

      // 2. Clean up old WebSocket before starting a new one
      if (websocket) {
        websocket.close();
        websocket = null;
      }

      websocket = new WebSocket(msg.serverUrl);
      
      websocket.onopen = () => {
        websocket.send(JSON.stringify({
          type: "metadata",
          sampleRate: audioContext.sampleRate
        }));
      };

      websocket.onmessage = (e) => {
        chrome.runtime.sendMessage({ type: 'UI_UPDATE', payload: JSON.parse(e.data) }).catch(() => {});
      };

      // 3. Re-wire the transcription path
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      processor.onaudioprocess = (e) => {
        if (websocket?.readyState === WebSocket.OPEN) {
          const input = e.inputBuffer.getChannelData(0);
          websocket.send(JSON.stringify({
            type: 'audio',
            data: btoa(String.fromCharCode(...new Uint8Array(input.buffer)))
          }));
        }
      };

    } catch (err) {
      console.error("Offscreen re-initialization failed:", err);
    }
  }

  if (msg.type === 'STOP_AUDIO') {
    // STOP the transcription path ONLY
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null; 
    }
    // KILL the socket to stop server costs/processing
    if (websocket) {
      websocket.close();
      websocket = null;
    }
    // Note: audioContext is NOT closed, so playback continues.
    // Note: chrome.offscreen.closeDocument() is NOT called to keep the stream alive.
  }
});