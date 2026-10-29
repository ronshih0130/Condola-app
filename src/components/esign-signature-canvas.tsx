"use client";

import { useRef, useState, type PointerEvent } from "react";
import { acceptableSignature, type Stroke, type Point } from "../server/esign/rules";
import { esignCopy } from "../server/esign/copy";

export type SignatureCanvasValue = {
  pngDataUrl: string;
  strokes: Point[][];
};

export type EsignSignatureCanvasProps = {
  locale?: keyof typeof esignCopy;
  disabled?: boolean;
  onSubmit: (value: SignatureCanvasValue) => void | Promise<void>;
};

const WIDTH = 720;
const HEIGHT = 240;

export default function EsignSignatureCanvas({
  locale = "zh-TW",
  disabled = false,
  onSubmit,
}: EsignSignatureCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const pointer = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = esignCopy[locale]["ES-05"];

  function updateReady() {
    setReady(acceptableSignature(strokes.current as Stroke[]));
  }

  function position(event: PointerEvent<HTMLCanvasElement>): Point {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(WIDTH, (event.clientX - box.left) * WIDTH / box.width)),
      y: Math.max(0, Math.min(HEIGHT, (event.clientY - box.top) * HEIGHT / box.height)),
    };
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || busy || pointer.current !== null || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
    strokes.current.push([position(event)]);
    setError("");
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (pointer.current !== event.pointerId || disabled || busy) return;
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const stroke = strokes.current.at(-1)!;
    const previous = stroke.at(-1)!;
    const point = position(event);
    stroke.push(point);
    context.strokeStyle = "#222222";
    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    updateReady();
  }

  function finish(event: PointerEvent<HTMLCanvasElement>) {
    if (pointer.current !== event.pointerId) return;
    move(event);
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateReady();
  }

  function clear() {
    if (disabled || busy) return;
    pointer.current = null;
    strokes.current = [];
    canvas.current?.getContext("2d")?.clearRect(0, 0, WIDTH, HEIGHT);
    setReady(false);
    setError("");
  }

  async function submit() {
    if (disabled || busy || pointer.current !== null || !canvas.current) return;
    if (!acceptableSignature(strokes.current)) {
      setError(copy.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        pngDataUrl: canvas.current.toDataURL("image/png"),
        strokes: strokes.current.map((stroke) => stroke.map((p) => ({ ...p }))),
      });
    } catch {
      setError(copy.submitError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>{copy.help}</p>
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        aria-label={copy.label}
        aria-describedby="esign-signature-instructions"
        style={{ width: "100%", maxWidth: WIDTH, height: "auto", touchAction: "none", border: "1px solid #777" }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={() => {
          pointer.current = null;
          updateReady();
        }}
      />
      <p id="esign-signature-instructions">{copy.instructions}</p>
      <button type="button" onClick={clear} disabled={disabled || busy}>{copy.clear}</button>
      <button type="button" onClick={submit} disabled={disabled || busy || !ready}>
        {busy ? copy.submitting : copy.submit}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
