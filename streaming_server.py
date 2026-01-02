#!/usr/bin/env python3
"""
Reliable sentence-level transcription for browser tab audio
No VAD, no silence detection, no partial hallucinations
"""

import asyncio, websockets, json, base64, os, tempfile, wave, time,traceback
import soundfile as sf
import sherpa_onnx
from datetime import datetime
from pathlib import Path

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

    print("🟢 Client connected")

    async for msg in ws:
        data = json.loads(msg)

        # NEW: Catch logs from the extension
        if data.get("type") == "CRASH_LOG":
            print(f"\n[EXTENSION CRASH DETECTED]: {data['message']}")
            print(f"Location: {data['source']} Line: {data['lineno']}")
            print(f"Stack: {data.get('error')}\n")
            continue

        if data.get("type") != "audio":
            continue

        pcm = base64.b64decode(data["data"])
        buffer.extend(pcm)

        now = time.time()
        duration = len(buffer) / (SAMPLE_RATE * SAMPLE_WIDTH)

        if now - last_decode_time >= DECODE_INTERVAL_SECONDS and duration >= 2.0:
            text = decode_pcm(buffer)

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
                # call LLM in background (non-blocking)
                asyncio.create_task(send_transcripts_to_llm_and_print(text, websocket=ws))


async def send_transcripts_to_llm_and_print(
    transcripts,
    websocket=None,
    model: str | None = None,
    max_tokens: int = 250,
    temperature: float = 0.0
) -> str | None:
    """
    Send recent transcript slices to an LLM and print the 'context' field returned.

    Args:
      transcripts: list[str] or str - rolling transcript slices (most recent first or in time order).
      websocket: optional websocket object; if provided, the function will send back
                 a message: {"type":"context_partial","json": {...}} where the JSON contains
                 the LLM response and metadata.
      model: optional model name (default from env MODEL or 'gpt-4o-mini').
      max_tokens: response token limit for LLM
      temperature: model temperature (0.0 recommended for deterministic JSON)

    Returns:
      The extracted context string, or None if extraction failed.

    Behavior:
      - Builds the prompt you specified exactly (asks for JSON with single field "context").
      - Uses the new OpenAI client if available and OPENAI_API_KEY environment variable is set.
      - If the model returns JSON with "context", that is printed and optionally sent to websocket.
      - If the model returns something else or parsing fails, best-effort extraction is attempted.
    """

    # --- normalize transcripts input into a single block ---
    if not transcripts:
        print("send_transcripts_to_llm_and_print: no transcripts provided")
        return None
    if isinstance(transcripts, (list, tuple)):
        # join with a newline and keep order as given
        combined = "\n".join(str(t).strip() for t in transcripts if t and str(t).strip())
    else:
        combined = str(transcripts).strip()

    if not combined:
        print("send_transcripts_to_llm_and_print: combined transcripts empty")
        return None

    # Prepare prompt exactly as user specified
    prompt = f"""
You are a highly-informed **Domain Expert** and **Knowledge Enhancement Engine**.
Your task is to analyze rolling slices of a video/meeting transcription, fuse them into meaningful sentences, and then provide relevant, in-depth **contextual knowledge** to enhance the user's understanding of the conversation or video content.

### Task Breakdown:
1.  **Sentence Fusion:** Combine the incoming transcript slices into one or more complete, meaningful sentences.
2.  **Sentence Priority:** Give the last sentence higher priority and try to complete the next steps accordigly
3.  **Knowledge Extraction:** Identify any **buzzwords, technical terms, concepts, interview questions, or key discussion points** within the highest priority sentence. 
    * Use the fused sentence(s) as augmented context to extract the most relevent knowledge from highest priority sentence. 
    * If no knowledge can be extracted then generate sample keywords based on fused sentence which can be used to continue the converstation.
4.  **Context Generation:** For the identified points, generate concise, relevant, and supportive knowledge.
    * **Goal:** The generated text should **explain** a term, **elaborate** on a concept, or **provide a similar/related example** that deepens the user's current understanding for the last sentence. The output is **not** a summary or a direct answer to a question in the transcript. Ideally the context should help continue the conversation or enhance the understanding of the conversation.
    * **Example (Interview):** If the transcript mentions "What's your experience with microservices?", the context should explain what microservices are, or list the core benefits/drawbacks.
    * **Example (Tech Video):** If the transcript mentions "quantum computing's entanglement," the context should concisely define entanglement in a computing context.

Return **ONLY one JSON object** (no commentary or surrounding text) with exactly one field named **"context"**.

Example of desired output:
{{"context": "Microservices is an architectural style where an application is structured as a collection of smaller, independent services, communicating via APIs."}}

If no clear contextual information or key concept/term is found in the fused transcript, set the value of "context" to the string **"No relevant context extracted"**.

Example of 'No context' output:
{{"context": "No relevant context extracted"}}

TRANSCRIPT:
\"\"\"{combined}
\"\"\"
"""

    # Model selection
    model = model or os.environ.get("MODEL") or "gpt-4o-mini"

    # Attempt to import and use new OpenAI client
    try:
        import openai
        from openai import OpenAI
    except Exception:
        OpenAI = None
        openai = None

    api_key = os.environ.get("OPENAI_API_KEY")
    # If OpenAI not available or API key missing, produce a tiny local fallback summary
    if OpenAI is None or not api_key:
        # Local fallback: naive combine into single sentence + keywords
        sentences = [s.strip() for s in combined.splitlines() if s.strip()]
        combined_sentence = " ".join(sentences[-3:]) if sentences else ""
        context_fallback = "No relevant context extracted"
        out = {"context": context_fallback, "timestamp": datetime.now().isoformat(), "source_count": len(sentences)}
        print("[LLM FALLBACK CONTEXT]:", json.dumps(out, indent=2, ensure_ascii=False))
        # send back to websocket if provided
        if websocket:
            try:
                await websocket.send(json.dumps({"type": "context_partial", "json": out}))
            except Exception:
                pass
        return out["context"]

    # Build messages for chat model
    messages = [
        {"role": "system", "content": "You are a concise meeting assistant. Output exactly one JSON object with one key: context."},
        {"role": "user", "content": prompt}
    ]

    # Create client and call LLM in a thread to avoid blocking the event loop
    try:
        client = OpenAI()
    except Exception as e:
        print("send_transcripts_to_llm_and_print: Failed to instantiate OpenAI client:", e)
        traceback.print_exc()
        return None

    # network call selector (wrapped in to_thread)
    def _call_llm():
        try:
            return client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except Exception as e_inner:
            # bubble up error
            raise

    try:
        resp = await asyncio.to_thread(_call_llm)
    except Exception as e:
        print("send_transcripts_to_llm_and_print: OpenAI API call failed:", e)
        traceback.print_exc()
        return None

    # Robust extraction of text content (handles different SDK shapes)
    text_str = ""
    try:
        # Try common shapes (resp.choices[0].message.content)
        # Many SDKs produce an object where choices[0].message.content is a list or a string
        ch = None
        try:
            # attribute-style
            ch = resp.choices[0]
        except Exception:
            try:
                ch = resp["choices"][0] if isinstance(resp, dict) else None
            except Exception:
                ch = None

        if ch is not None:
            # try message -> content (list or str)
            msg = getattr(ch, "message", None) if hasattr(ch, "message") else (ch.get("message") if isinstance(ch, dict) else None)
            if isinstance(msg, dict) and "content" in msg:
                cont = msg["content"]
                if isinstance(cont, (list, tuple)) and cont:
                    first = cont[0]
                    if isinstance(first, dict) and "text" in first:
                        text_str = first["text"]
                    elif isinstance(first, str):
                        text_str = first
                elif isinstance(cont, str):
                    text_str = cont
            # fallback to other keys on ch
            if not text_str:
                for key in ("text", "content", "delta"):
                    if hasattr(ch, key):
                        val = getattr(ch, key)
                        if isinstance(val, str) and val.strip():
                            text_str = val.strip()
                            break
                    elif isinstance(ch, dict) and key in ch and isinstance(ch[key], str) and ch[key].strip():
                        text_str = ch[key].strip()
                        break

        # Ultimate fallback: stringify resp
        if not text_str:
            try:
                text_str = str(resp)
            except Exception:
                text_str = ""
    except Exception:
        text_str = str(resp)

    # strip code fences if present
    if text_str.startswith("```") and "```" in text_str[3:]:
        parts = text_str.split("```")
        if len(parts) >= 2:
            text_str = parts[1].strip()

    # Now try to parse JSON exactly as we asked (one object with "context")
    context_val = None
    try:
        parsed = json.loads(text_str)
        if isinstance(parsed, dict):
            # Prefer "context" field
            if "context" in parsed:
                context_val = parsed["context"]
            # if model returned "command" due to earlier examples, accept it
            elif "command" in parsed:
                context_val = parsed["command"]
            else:
                # If some other single key exists, take its value as string
                if len(parsed) == 1:
                    context_val = list(parsed.values())[0]
                else:
                    # convert entire dict to string (best-effort)
                    context_val = json.dumps(parsed, ensure_ascii=False)
    except Exception:
        # not pure JSON; try to find JSON substring within text
        try:
            fb = text_str.find("{")
            lb = text_str.rfind("}")
            if fb != -1 and lb != -1 and lb > fb:
                candidate = text_str[fb:lb+1]
                parsed2 = json.loads(candidate)
                if isinstance(parsed2, dict):
                    if "context" in parsed2:
                        context_val = parsed2["context"]
                    elif "command" in parsed2:
                        context_val = parsed2["command"]
                    elif len(parsed2) == 1:
                        context_val = list(parsed2.values())[0]
                    else:
                        context_val = json.dumps(parsed2, ensure_ascii=False)
        except Exception:
            pass

    # If still nothing, use fallback: choose first non-empty line from text_str
    if context_val is None:
        # Extract meaningful sentence from the LLM text if possible
        lines = [ln.strip() for ln in text_str.splitlines() if ln.strip()]
        if lines:
            # prefer shorter lines that look like a sentence
            lines_sorted = sorted(lines, key=lambda s: (len(s), -len(s.split())))
            context_val = lines_sorted[0]
        else:
            context_val = None

    if context_val is None:
        print("send_transcripts_to_llm_and_print: failed to extract context. Raw LLM text:")
        print(text_str[:4000])
        # optionally send error to websocket
        if websocket:
            try:
                await websocket.send(json.dumps({"type": "context_partial_error", "raw": "No relevant context extracted"}))
            except Exception:
                pass
        return None

    # normalize to string and print
    if isinstance(context_val, (dict, list)):
        context_out = json.dumps(context_val, ensure_ascii=False)
    else:
        context_out = str(context_val).strip()

    out_json = {
        "context": context_out,
        "model": model,
        "generated_at": datetime.now().isoformat(),
        "source_len": len(combined),
    }

    # print to server console (user requested print)
    print("\n[LLM CONTEXT]:")
    print(json.dumps(out_json, indent=2, ensure_ascii=False))

    # optionally send to websocket
    if websocket:
        try:
            await websocket.send(json.dumps({"type": "context_partial", "json": out_json}))
        except Exception as e:
            print("send_transcripts_to_llm_and_print: failed to send context to websocket:", e)

    return context_out


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
