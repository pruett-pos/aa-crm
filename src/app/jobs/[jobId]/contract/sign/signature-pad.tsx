"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type SignaturePadHandle = { clear(): void; toDataUrl(): string | null };

const WIDTH = 700, HEIGHT = 220;
const MIN_POINTS = 25; // a tap or a tiny dot is not a signature

/** Draw-to-sign canvas for touch, pen and mouse. White background so a blank pad is obviously tiny. */
export const SignaturePad = forwardRef<SignaturePadHandle, { label: string; onChange?: (hasInk: boolean) => void }>(
  function SignaturePad({ label, onChange }, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const points = useRef(0);
    const [, force] = useState(0);

    const reset = () => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1a1a1a";
      points.current = 0;
      onChange?.(false);
      force((n) => n + 1);
    };

    useEffect(reset, []); // eslint-disable-line react-hooks/exhaustive-deps

    useImperativeHandle(ref, () => ({
      clear: reset,
      toDataUrl: () => (points.current >= MIN_POINTS ? canvas.current?.toDataURL("image/png") ?? null : null),
    }));

    const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * WIDTH, y: ((e.clientY - r.top) / r.height) * HEIGHT };
    };

    return (
      <canvas
        ref={canvas} width={WIDTH} height={HEIGHT} className="sigpad" role="img" aria-label={label}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const { x, y } = pos(e);
          const ctx = e.currentTarget.getContext("2d")!;
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const { x, y } = pos(e);
          const ctx = e.currentTarget.getContext("2d")!;
          ctx.lineTo(x, y);
          ctx.stroke();
          points.current += 1;
          if (points.current === MIN_POINTS) onChange?.(true);
        }}
        onPointerUp={() => { drawing.current = false; }}
        onPointerCancel={() => { drawing.current = false; }}
      />
    );
  },
);
