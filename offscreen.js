let websocket = null;
let audioContext = null;
let processor = null;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.target !== 'offscreen-doc') return;

  if (msg.type === 'INITIALIZE_AUDIO') {
    try {
      // Create the stream from the ID passed by background
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
      websocket.onmessage = (e) => {
        chrome.runtime.sendMessage({ type: 'UI_UPDATE', payload: JSON.parse(e.data) }).catch(() => {});
      };

      // CHANGE: Removed { sampleRate: 16000 } to keep crystal clear playback quality
      audioContext = new AudioContext(); 
      
      // Store the hardware rate to tell the downsampler how to convert for the server
      const hardwareRate = audioContext.sampleRate;

      const source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(16384, 1, 1);

      // Playback: Connect source to destination at full hardware quality
      source.connect(audioContext.destination);
      
      // Processing: Connect source to processor
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      processor.onaudioprocess = (e) => {
        if (websocket?.readyState === WebSocket.OPEN) {
          const input = e.inputBuffer.getChannelData(0);
          
          // CHANGE: Passing hardwareRate instead of fixed 16000 
          // This downsamples the data for the server without affecting what you hear
          const pcm16 = floatTo16(downsample(input, hardwareRate, 16000));
          
          websocket.send(JSON.stringify({
            type: 'audio',
            data: btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)))
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

// MATH FUNCTIONS (Use your original versions)
function downsample(buffer, inputSR, outputSR) {
  const ratio = inputSR / outputSR;
  const out = new Float32Array(Math.round(buffer.length / ratio));
  let idx = 0;
  for (let i = 0; i < out.length; i++) {
    const pos = idx | 0;
    const frac = idx - pos;
    out[i] = buffer[pos] + ((buffer[pos+1] || buffer[pos]) - buffer[pos]) * frac;
    idx += ratio;
  }
  return out;
}

function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}