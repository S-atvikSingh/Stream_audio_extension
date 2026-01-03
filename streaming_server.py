#!/usr/bin/env python3
"""
Reliable sentence-level transcription for browser tab audio
No VAD, no silence detection, no partial hallucinations
"""

import asyncio, websockets, json, base64, os, tempfile, wave, time, traceback, librosa, sherpa_onnx
import soundfile as sf
from datetime import datetime
from pathlib import Path
import numpy as np

# ================= CONFIG =================
MODEL_DIR = r"C:\sherpa_models\sherpa-onnx-whisper-tiny.en"
HOST, PORT = "localhost", 8765

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2

DECODE_INTERVAL_SECONDS = 6.0      # sentence-sized chunks
OVERLAP_SECONDS = 1.0              # keep context
# =========================================


# ---------- Load Whisper ----------
def discover(md):
    md = Path(md)
    return (
        next(md.glob("*tokens*.txt")),
        next(md.glob("*encoder*.onnx")),
        next(md.glob("*decoder*.onnx")),
    )

tokens, encoder, decoder = discover(MODEL_DIR)

recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder=str(encoder),
    decoder=str(decoder),
    tokens=str(tokens),
)

print("✔ Whisper model loaded")


# ---------- Decode ----------
def decode_pcm(pcm):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        with wave.open(f.name, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(SAMPLE_WIDTH)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm)

    audio, sr = sf.read(f.name, dtype="float32")
    os.remove(f.name)

    stream = recognizer.create_stream()
    stream.accept_waveform(sr, audio)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


# ---------- WebSocket ----------
async def handle(ws):
    buffer = bytearray()
    last_decode_time = time.time()
    # Default fallback if metadata is missed
    input_sample_rate = 44100 

    print("🟢 Client connected")

    async for msg in ws:
        data = json.loads(msg)

        if data.get("type") == "metadata":
            input_sample_rate = data.get("sampleRate", 44100)
            print(f"📡 Hardware Sample Rate detected: {input_sample_rate}Hz")
            continue

        if data.get("type") != "audio":
            continue

        # 1. Decode base64 back to raw bytes
        raw_bytes = base64.b64decode(data["data"])
        
        # 2. Interpret bytes as 32-bit floats (matching JS Float32Array)
        audio_floats = np.frombuffer(raw_bytes, dtype=np.float32)
        
        # 3. Resample from hardware rate to Whisper's 16000Hz
        if input_sample_rate != SAMPLE_RATE:
            audio_resampled = librosa.resample(
                audio_floats, 
                orig_sr=input_sample_rate, 
                target_sr=SAMPLE_RATE
            )
        else:
            audio_resampled = audio_floats

        # 4. Perform float-to-int16 conversion on the server
        audio_int16 = (np.clip(audio_resampled, -1.0, 1.0) * 32767).astype(np.int16)
        
        # 5. Extend buffer with the processed bytes
        buffer.extend(audio_int16.tobytes())

        now = time.time()
        duration = len(buffer) / (SAMPLE_RATE * SAMPLE_WIDTH)

        if now - last_decode_time >= DECODE_INTERVAL_SECONDS and duration >= 2.0:
            text = decode_pcm(buffer) # Existing whisper decode logic

            # keep overlap
            keep = int(OVERLAP_SECONDS * SAMPLE_RATE * SAMPLE_WIDTH)
            buffer = buffer[-keep:]

            last_decode_time = now

            if text:
                await ws.send(json.dumps({
                    "type": "transcription",
                    "text": text,
                    "timestamp": datetime.now().isoformat()
                }))
                asyncio.create_task(send_transcripts_to_llm_and_print(text, websocket=ws))
                
async def send_transcripts_to_llm_and_print(
    transcripts,
    websocket=None,
    model: str | None = None,
    max_tokens: int = 600,
    temperature: float = 0.0
) -> str | None:
    """
    Autonomous Technical Strategist: Detects intent, fills technical gaps,
    and provides generative blueprints instead of basic definitions.
    """

    # 1. Normalize and validate input
    if not transcripts:
        return None
    if isinstance(transcripts, (list, tuple)):
        combined = "\n".join(str(t).strip() for t in transcripts if t)
    else:
        combined = str(transcripts).strip()

    if not combined:
        return None

    # 2. Enhanced Autonomous Prompt
    prompt = f"""
You are a highly-informed **Domain Expert Architect** and **Knowledge Enhancement Engine**.
Your task is to analyze rolling slices of a transcript, fuse them, and provide generative technical insights.

### PHASE 1: TRANSCRIPT ANALYSIS
1. **Sentence Fusion:** Combine transcript slices into complete, meaningful sentences. Since the transcriptions might be for non native users 
check and correct the words as needed to have a meaningful sentence. 
for example: 
Transcript: "Understanding underlying concepts helped me use tools like Catchy B.T. and Google B.R."
Meaning: "Understanding underlying concepts helped me use tools like ChatGPT and Google Bard"
that is use the phonetic similarity to find meaniingful sentence rather than the normal typing similarity.

2. **Sentence Priority:** Give the LAST sentence the highest priority. Extract keywords and intent primarily from the most recent speech.

3. **Archetype Detection:** Automatically detect if the setting is a **Technical Interview**, **Product/Tech Review**, **Educational Lecture** or **Generic conversation/meeting**.

### PHASE 2: CONTEXT GENERATION (THE STRATEGIST)
Based on the detected setting, generate the "context" field using the most appropriate of the following rules. 
If a specific rule is not applicable then do not hallucinate or fake the data. If multiple settings are applicable then use the most
suitable rules for the current conversation to generate the context and arrange the context in a logical format.

- **IF TECHNICAL INTERVIEW:**
  - Provide a "Professional Opening" to help the user start their answer.
  - Provide 3-4 "Mastery Keywords" (architectural patterns or edge cases).
  - Provide a [STAR] or [System Design] generic template to fill with experience.
  
- **IF PRODUCT/TECH REVIEW:**
  - Provide a "Comparative Analysis" (how this feature compares to industry standards or old versions).
  - Provide a concise lists of Pros/Cons.

- **IF LECTURES/EDUCATIONAL:**
  - Provide "Memory Refresh" that is prerequisite logic/knowledge in concise format and/or valid Markdown links to access such knowledge.
    i.e. it should be of the format <a href="www.example.com"> example </a>
  - Provide valid Markdown links to official docs (MDN, AWS, etc.) for clickable deep-dives.
  - All links should be valid Markdown links in clickable format. i.e. it should be of the format <a href="www.example.com"> example </a>
so that the link can be directly clicked by the user so as to open the link in the background while the meeting/video is still ongoing.


If the conversation can be several of the above categories then mix and match the context provided as appropriate. 
You may use the below given options to enhnace the context
- If an keyword, API or tool is mentioned, do not just define it. Provide a generic boilerplate construction (e.g., a sample REST payload or code snippet).
- Explain one specific way the discussed logic fails under 10x load or suggest possible optimization.
- Identify what the speaker *didn't* mention but should have (e.g., indexing, security, or scaling).

### PHASE 3: 
- Remember that the context provided will change as the conversation continues so the context should be consice and helpful.
- The context should not repeat information already explained in either the conversation or previous context.
- The context should not include information like context generation strategies used by us. It should only provide information immediately
helpful to the user.
- If the context uses several different points the the points should be seperated into different paragraphs to make it easy to 
read when displayed in HTML div text. 
- Assume the context will be displayed as text in an HTML div, format the content accordingly.

### CONSTRAINTS:
- Return ONLY one JSON object with exactly one field: "context".
- If no knowledge can be extracted (small talk), return {{"context": "No relevant context extracted"}}.
- The links mentioned should be real links which can be accessed not fake links or placeholders.
- All links should be valid Markdown links in clickable format. i.e. it should be of the format <a href="www.example.com"> example </a>
so that the link can be directly clicked by the user so as to open the link in the background while the meeting/video is still ongoing.
- The result context should be human readable and not include things like the settings, resources etc used for context generation.

TRANSCRIPT:
\"\"\"{combined}\"\"\"
"""

    model = model or os.environ.get("MODEL") or "gpt-4o-mini"

    # 3. Setup OpenAI Client
    try:
        from openai import OpenAI
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            print("[LLM ERROR]: OPENAI_API_KEY not found in environment.")
            return None
        client = OpenAI()
    except Exception as e:
        print(f"[LLM ERROR]: {e}")
        return None

    messages = [
        {"role": "system", "content": "You are a Knowledge Enhancement Engine. You receive trancript of conversation and then provide"
        " Output of exactly one JSON object with one key: context."},
        {"role": "user", "content": prompt}
    ]

    try:
        # 4. Threaded API call to prevent audio processing lag
        resp = await asyncio.to_thread(
            lambda: client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        )
        
        # 5. Strict Extraction to prevent 'garbage' metadata results
        raw_text = resp.choices[0].message.content.strip()

        # Handle Markdown code blocks if LLM includes them
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1].replace("json", "").strip()

        # Parse JSON and extract context
        try:
            parsed = json.loads(raw_text)
            context_val = parsed.get("context", raw_text)
        except json.JSONDecodeError:
            context_val = raw_text

    except Exception as e:
        print(f"send_transcripts_to_llm_and_print failed: {e}")
        return None

    # 6. Final Data Assembly for UI
    out_json = {
        "context": str(context_val),
        "model": model,
        "generated_at": datetime.now().isoformat(),
        "source_len": len(combined),
    }

    print("\n[LLM CONTEXT]:")
    print(json.dumps(out_json, indent=2, ensure_ascii=False))

    if websocket:
        try:
            await websocket.send(json.dumps({"type": "context_partial", "json": out_json}))
        except Exception:
            pass

    return out_json["context"]

async def main():
    print("Started")
    async with websockets.serve(
        handle, 
        HOST, 
        PORT,
        max_size=2**24,          # Increase max message size (16MB)
        ping_interval=None,      # Disable ping to prevent timeout during heavy CPU load
        ping_timeout=None
    ):
        print(f"Listening on ws://{HOST}:{PORT}")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
